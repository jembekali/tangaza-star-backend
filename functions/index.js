// index.js (VERSION 8.0: FINAL - SMART FEED & FIXED DELETION)

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

// Twabisubije hano hejuru nk'uko byahoze
const ffmpeg_static = require("ffmpeg-static");
const sharp = require("sharp");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// <--- HELPERS: RETRY LOGIC --->
async function updatePostWithRetry(postId, updateData) {
    const postRef = db.collection('posts').doc(postId);
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
        const doc = await postRef.get();
        if (doc.exists) {
            await postRef.update(updateData);
            console.log(`SUCCESS: Post ${postId} updated.`);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`FAILED: Post ${postId} not found after retries.`);
}

async function updateChatMessageWithRetry(chatRoomID, messageId, updateData) {
    const msgRef = db.collection('chat_rooms').doc(chatRoomID).collection('messages').doc(messageId);
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
        const doc = await msgRef.get();
        if (doc.exists) {
            await msgRef.update(updateData);
            console.log(`SUCCESS: Chat Message ${messageId} updated.`);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// =========================================================================
// ----> MEDIA OPTIMIZATION (FINAL) <----
// =========================================================================
exports.handleMediaOptimization = functions
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .storage.object().onFinalize(async (object) => {
    
    const filePath = object.name;
    const contentType = object.contentType;
    const fileName = path.basename(filePath);

    // 1. Skip Profiles
    if (filePath.startsWith("profile_pictures/")) return null;

    // 2. Skip Optimized & Thumbnails
    if (fileName.startsWith("optimized_") || fileName.startsWith("thumb_") || fileName === "thumbnail.jpg") {
      return null;
    }

    // 3. Check Media Type
    const isVideo = contentType.startsWith("video/");
    const isImage = contentType.startsWith("image/");
    if (!isImage && !isVideo) return null;
    
    // Paths
    const tempFilePath = path.join(os.tmpdir(), fileName);
    const thumbFileName = "thumb_" + path.parse(fileName).name + ".jpg";
    const tempThumbPath = path.join(os.tmpdir(), thumbFileName);
    const optimizedThumbPath = path.join(path.dirname(filePath), thumbFileName);

    const optimizedExtension = isVideo ? ".mp4" : ".webp";
    const optimizedContentType = isVideo ? "video/mp4" : "image/webp";
    const optimizedFileName = "optimized_" + path.parse(fileName).name + optimizedExtension;
    const tempOptimizedPath = path.join(os.tmpdir(), optimizedFileName);
    const optimizedFilePath = path.join(path.dirname(filePath), optimizedFileName);

    try {
      await bucket.file(filePath).download({ destination: tempFilePath });

      if (isVideo) {
        const videoCompressionPromise = new Promise((resolve, reject) => {
          spawn(ffmpeg_static, ['-i', tempFilePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', tempOptimizedPath])
          .on('close', resolve).on('error', reject);
        });
        const thumbnailGenerationPromise = new Promise((resolve, reject) => {
          spawn(ffmpeg_static, ['-i', tempFilePath, '-ss', '00:00:01.000', '-vframes', '1', tempThumbPath])
          .on('close', resolve).on('error', reject);
        });
        
        await Promise.all([videoCompressionPromise, thumbnailGenerationPromise]);

        await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: optimizedContentType } });
        await bucket.upload(tempThumbPath, { destination: optimizedThumbPath, metadata: { contentType: 'image/jpeg' } });

        const optimizedFile = bucket.file(optimizedFilePath);
        const thumbFile = bucket.file(optimizedThumbPath);
        const [videoUrl] = await optimizedFile.getSignedUrl({ action: 'read', expires: '03-09-2491' });
        const [thumbUrl] = await thumbFile.getSignedUrl({ action: 'read', expires: '03-09-2491' });
        
        if (filePath.startsWith("posts/")) {
            const postId = path.parse(fileName).name; 
            await updatePostWithRetry(postId, { videoUrl: videoUrl, imageUrl: thumbUrl });
        }
        else if (filePath.startsWith("chat_media/")) {
            const parts = filePath.split('/');
            if (parts.length >= 4) {
                const chatRoomID = parts[1];
                const messageId = parts[2];
                await updateChatMessageWithRetry(chatRoomID, messageId, { 
                    fileUrl: videoUrl,
                    thumbnailUrl: thumbUrl,
                    status: 'sent'
                });
            }
        }
        
      } else { 
        await sharp(tempFilePath).webp({ quality: 80 }).toFile(tempOptimizedPath);
        await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: optimizedContentType } });
        const optimizedFile = bucket.file(optimizedFilePath);
        const [newUrl] = await optimizedFile.getSignedUrl({ action: 'read', expires: '03-09-2491' });
        
        if (filePath.startsWith("posts/")) {
          const postId = path.parse(fileName).name;
          await updatePostWithRetry(postId, { imageUrl: newUrl });
        }
        else if (filePath.startsWith("chat_media/")) {
            const parts = filePath.split('/');
            if (parts.length >= 4) {
                const chatRoomID = parts[1];
                const messageId = parts[2];
                await updateChatMessageWithRetry(chatRoomID, messageId, { 
                    fileUrl: newUrl,
                    status: 'sent'
                });
            }
        }
      }

    } catch (error) {
      console.error(`Error optimizing media (${filePath}):`, error);
    } finally {
      if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
      if(fs.existsSync(tempThumbPath)) fs.unlinkSync(tempThumbPath);
      
      // Cleanup Original (Keep only if needed)
      if (!filePath.startsWith("profile_pictures/") && !filePath.startsWith("chat_media/")) {
        try {
            await bucket.file(filePath).delete();
        } catch (e) {
            console.log(`Could not delete original: ${e.message}`);
        }
      }
    }
    return null;
  });

// =========================================================================
// ----> FEED ALGORITHM (SMART: SHOWS FRESH CONTENT FIRST) <----
// =========================================================================

exports.getForYouFeed = functions.https.onCall(async (data, context) => { 
    const userId = context.auth.uid; 
    if (!userId) throw new functions.https.HttpsError("unauthenticated", "Auth required."); 
    
    // 1. Fetch Candidates (Hot, New, Stars)
    const starsQuery = db.collection("posts").where("isStar", "==", true).limit(5); 
    const hotQuery = db.collection("posts").orderBy("hotScore", "desc").limit(30); 
    const newQuery = db.collection("posts").orderBy("timestamp", "desc").limit(20); 
    
    let personalizedPosts = []; 
    // Fetch user preferences (Authors they like)
    const interestsDoc = await db.collection("user_interests").doc(userId).get(); 
    
    if (interestsDoc.exists) { 
        const interestsData = interestsDoc.data(); 
        const likedAuthors = interestsData.likedAuthors || {}; 
        const topAuthors = Object.keys(likedAuthors).sort((a, b) => likedAuthors[b] - likedAuthors[a]).slice(0, 5); 
        
        if (topAuthors.length > 0) { 
            const personalizedQuery = db.collection("posts").where("userId", "in", topAuthors).orderBy("timestamp", "desc").limit(10); 
            const personalizedSnapshot = await personalizedQuery.get(); 
            personalizedPosts = personalizedSnapshot.docs; 
        } 
    } 

    const [starsSnapshot, hotSnapshot, newSnapshot] = await Promise.all([starsQuery.get(), hotQuery.get(), newQuery.get()]); 
    
    // 2. Combine all potential posts
    let allPosts = [...starsSnapshot.docs, ...hotSnapshot.docs.slice(0, 15), ...newSnapshot.docs.slice(0, 10), ...personalizedPosts]; 

    // 3. Remove Duplicates
    const uniquePostsMap = new Map();
    allPosts.forEach(doc => uniquePostsMap.set(doc.id, doc));
    const uniquePosts = Array.from(uniquePostsMap.values());

    // 4. SMART FILTER: Separate "Liked" from "Unliked"
    // Hano niho hari ubwenge: Dutandukanya ibyo wakozeho Like n'ibyo utarabona.
    const unlikedPosts = [];
    const likedPosts = [];

    uniquePosts.forEach(doc => {
        const postData = doc.data();
        const likedBy = postData.likedBy || [];
        
        if (likedBy.includes(userId)) {
            likedPosts.push(doc);
        } else {
            unlikedPosts.push(doc);
        }
    });

    // 5. Final Selection
    let finalFeedDocs = [];

    // Niba hari posts nibura 3 utarakunda, kwereka izo gusa (Fresh Content).
    // Niba ari nkeya, vanga byose kugira ngo Feed itaba ubusa.
    if (unlikedPosts.length >= 3) {
        finalFeedDocs = unlikedPosts;
    } else {
        finalFeedDocs = [...unlikedPosts, ...likedPosts];
    }

    // 6. Shuffle (Kuvanga)
    for (let i = finalFeedDocs.length - 1; i > 0; i--) { 
        const j = Math.floor(Math.random() * (i + 1)); 
        [finalFeedDocs[i], finalFeedDocs[j]] = [finalFeedDocs[j], finalFeedDocs[i]]; 
    } 

    // 7. Prepare Response
    const processedPostsPromises = finalFeedDocs.map(async (doc) => { 
        const postData = doc.data(); 
        const commentsSnapshot = await db.collection('posts').doc(doc.id).collection('comments').get(); 
        return { id: doc.id, ...postData, commentsCount: commentsSnapshot.size }; 
    }); 
    
    return await Promise.all(processedPostsPromises); 
});

exports.calculateHotScore = functions.firestore.document("posts/{postId}").onWrite(async (change, context) => { if (!change.after.exists) return null; const postData = change.after.data(); let effectiveLikes; const isNewPost = !change.before.exists; if (isNewPost) { effectiveLikes = 5; } else { effectiveLikes = postData.likes || 0; } if (!postData.timestamp) return null; const postTimestamp = postData.timestamp.toDate(); const now = new Date(); const ageInMillis = now.getTime() - postTimestamp.getTime(); const ageInHours = ageInMillis / (1000 * 60 * 60); const newHotScore = effectiveLikes / Math.pow(ageInHours + 2, 1.8); const oldHotScore = postData.hotScore || 0; if (Math.abs(newHotScore - oldHotScore) < 0.0001) return null; return change.after.ref.update({ hotScore: newHotScore }); });
exports.updateUserInterestsOnLike = functions.firestore.document("user_likes/{likeId}").onCreate(async (snap, context) => { const likeData = snap.data(); const { userId, postId } = likeData; if (!userId || !postId) return null; const postDoc = await db.collection("posts").doc(postId).get(); if (!postDoc.exists) return null; const postData = postDoc.data(); const authorId = postData.userId; if (!authorId) return null; const userInterestsRef = db.collection("user_interests").doc(userId); return db.runTransaction(async (transaction) => { const interestsDoc = await transaction.get(userInterestsRef); if (!interestsDoc.exists) { transaction.set(userInterestsRef, { likedAuthors: { [authorId]: 1 } }); } else { const interestsData = interestsDoc.data(); const currentAuthorScore = (interestsData.likedAuthors && interestsData.likedAuthors[authorId]) || 0; const newLikedAuthors = { ...(interestsData.likedAuthors || {}), [authorId]: currentAuthorScore + 1 }; transaction.update(userInterestsRef, { likedAuthors: newLikedAuthors }); } }); });
exports.incrementPostView = functions.firestore.document("post_views/{viewId}").onCreate(async (snap, context) => { const { postId } = snap.data(); if (!postId) return null; try { await db.collection("posts").doc(postId).update({ views: admin.firestore.FieldValue.increment(1) }); } catch (error) { console.error(error); } return null; });

// =========================================================================
// ----> CLEANUP & DELETION LOGIC (FIXED) <----
// =========================================================================

// Iyi Function isiba Posts zishaje, ariko yubaha STARS
exports.deleteOldRegularPosts = functions.pubsub.schedule("every 1 hours").onRun(async (context) => { 
    const timeLimit = new Date(); 
    timeLimit.setHours(timeLimit.getHours() - 24); 
    const nowTimestamp = admin.firestore.Timestamp.now();

    const snapshot = await db.collection("posts").where("timestamp", "<", admin.firestore.Timestamp.fromDate(timeLimit)).get(); 
    if (snapshot.empty) return null; 

    const batch = db.batch(); 
    let deleteCount = 0;

    snapshot.docs.forEach((doc) => { 
        const data = doc.data();
        
        // LOGIC NSHYA:
        // Siba niba ATARI Star, CYANGWA niba ARI Star ariko igihe cyayo cyarenze.
        const isExpiredStar = data.isStar === true && data.starExpiryTimestamp && data.starExpiryTimestamp < nowTimestamp;
        
        if (!data.isStar || isExpiredStar) {
            batch.delete(doc.ref); 
            deleteCount++;
            console.log(`Deleting Post: ${doc.id} (Expired Star: ${isExpiredStar})`);
        }
    }); 

    if (deleteCount > 0) await batch.commit();
    console.log(`Cleaned up ${deleteCount} posts.`);
    return null; 
});

// Iyi Function isukura Storage
exports.cleanupStorageOnPostDelete = functions.firestore.document("posts/{postId}").onDelete(async (snap, context) => {
  const data = snap.data();
  const fileUrls = [];

  if (data.imageUrl) fileUrls.push(data.imageUrl);
  if (data.videoUrl) fileUrls.push(data.videoUrl);

  const deletePromises = fileUrls.map(async (url) => {
    try {
      const decodedUrl = decodeURIComponent(url);
      const startIndex = decodedUrl.indexOf("/o/") + 3;
      const endIndex = decodedUrl.indexOf("?");
      
      if (startIndex > 2 && endIndex > startIndex) {
        const fullPath = decodedUrl.substring(startIndex, endIndex);
        await bucket.file(fullPath).delete();
        console.log(`Deleted Storage File: ${fullPath}`);
      }
    } catch (error) {
      console.log(`Storage cleanup error: ${error.message}`);
    }
  });

  await Promise.all(deletePromises);
  return null;
});

// =========================================================================
// ----> STAR MANAGEMENT <----
// =========================================================================
exports.unstarOldStars = functions.pubsub.schedule("every day 17:55").timeZone("Africa/Bujumbura").onRun(async (context) => { const now = admin.firestore.Timestamp.now(); const snapshot = await db.collection("posts").where("isStar", "==", true).where("starExpiryTimestamp", "<", now).get(); if (snapshot.empty) return null; const batch = db.batch(); snapshot.docs.forEach((doc) => { batch.update(doc.ref, { isStar: false }); }); await batch.commit(); return null; });
exports.calculateAndAssignStars = functions.pubsub.schedule("every day 18:00").timeZone("Africa/Bujumbura").onRun(async (context) => { const now = new Date(); const timeLimit = new Date(now.getTime() - 24 * 60 * 60 * 1000); const snapshot = await db.collection("posts").where("timestamp", ">=", admin.firestore.Timestamp.fromDate(timeLimit)).get(); if (snapshot.empty) return null; const postsWithScore = snapshot.docs.map((doc) => { const data = doc.data(); const likes = data.likes || 0; const ageInHours = (now.getTime() - data.timestamp.toDate().getTime()) / (1000 * 60 * 60); return { id: doc.id, score: likes / Math.pow(ageInHours + 2, 1.8) }; }); postsWithScore.sort((a, b) => b.score - a.score); const top5 = postsWithScore.slice(0, 5); if (top5.length === 0) return null; const batch = db.batch(); const expiry = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 24 * 60 * 60 * 1000)); top5.forEach((post) => { batch.update(db.collection("posts").doc(post.id), { isStar: true, starExpiryTimestamp: expiry }); }); await batch.commit(); return null; });
exports.sendStarNotification = functions.firestore.document("posts/{postId}").onUpdate(async (change, context) => { if (change.before.data().isStar === false && change.after.data().isStar === true) { const { userId } = change.after.data(); if (!userId) return null; await db.collection("notifications").add({ userId: userId, title: "Wakoze Neza, Wabaye Star Wacu ⭐!", body: "Ijambo ryawe ryakoze kumitima y'abenshi. Post yawe yabaye muri zitanu nziza mumasaha 24 aheze! Igiye rero kumara ayandi masaha 24 mu kibanza categekanirijwe aba Stars ⭐ kugira n'abandi babone iciyumviro cawe kidasanzwe. TURAGUKEJE RERO STAR WACU ⭐! Jembe Talk yemerewe kwifashisha iyi post yawe mu kwamamaza ibikorwa vyayo. (TANGAZA STAR⭐)", timestamp: admin.firestore.FieldValue.serverTimestamp(), isRead: false, relatedPostId: context.params.postId, type: "star_winner", }); } return null; });
exports.deleteOldStarNotifications = functions.pubsub.schedule("every day 18:01").timeZone("Africa/Bujumbura").onRun(async (context) => { const timeLimit = new Date(); timeLimit.setHours(timeLimit.getHours() - 24); timeLimit.setMinutes(timeLimit.getMinutes() - 30); const snapshot = await db.collection("notifications").where("type", "==", "star_winner").where("timestamp", "<", admin.firestore.Timestamp.fromDate(timeLimit)).get(); if (snapshot.empty) return null; const batch = db.batch(); snapshot.docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); return null; });
exports.blockChatMessageOnCreate = functions.firestore.document("chat_rooms/{chatRoomId}/messages/{messageId}").onCreate(async (snap, context) => {});