// functions/index.js (VERSION YANYUMA KANDI YIZEYE ISHINGIYE KU YAWE YA KERA)

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const ffmpeg_static = require("ffmpeg-static");
const sharp = require("sharp");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// =========================================================================
// ----> IGIKORWA #3: KUVANGA AMAPOSITA ("FOR YOU" FEED) - VERSION IKOSOYe <----
// =========================================================================
exports.generateForYouFeed = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Ugomba kuba winjiye kugira ubone amaposita.');
  }
  const userId = context.auth.uid;

  try {
    const hotAndNewQuery = db.collection('posts')
      .where('isStar', '==', false)
      .orderBy('timestamp', 'desc')
      .limit(20); 

    const recentLikesQuery = db.collection('posts')
      .where('likedBy', 'array-contains', userId)
      .orderBy('timestamp', 'desc')
      .limit(10);
      
    const [hotAndNewSnapshot, recentLikesSnapshot] = await Promise.all([
      hotAndNewQuery.get(),
      recentLikesQuery.get(),
    ]);

    let personalizedPosts = [];
    if (!recentLikesSnapshot.empty) {
      const likedAuthors = recentLikesSnapshot.docs.map(doc => doc.data().userId).filter(id => id);
      const uniqueAuthors = [...new Set(likedAuthors)]; 
      
      if (uniqueAuthors.length > 0) {
        const authorsForQuery = uniqueAuthors.slice(0, 10);
        const personalizedQuery = db.collection('posts')
          .where('isStar', '==', false)
          .where('userId', 'in', authorsForQuery)
          .orderBy('timestamp', 'desc')
          .limit(10);
        const personalizedSnapshot = await personalizedQuery.get();
        personalizedPosts = personalizedSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      }
    }
    
    const hotAndNewPosts = hotAndNewSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    const allPostsMap = new Map();
    [...hotAndNewPosts, ...personalizedPosts].forEach(post => {
      if (post.id && post.timestamp) { 
        allPostsMap.set(post.id, post);
      }
    });

    let combinedPosts = Array.from(allPostsMap.values());
    
    combinedPosts.sort((a, b) => {
      const scoreA = a.hotScore || 0;
      const scoreB = b.hotScore || 0;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return b.timestamp._seconds - a.timestamp._seconds;
    });
    
    const topPosts = combinedPosts.slice(0, 10);
    for (let i = topPosts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [topPosts[i], topPosts[j]] = [topPosts[j], topPosts[i]];
    }
    const finalCombinedPosts = [...topPosts, ...combinedPosts.slice(10)];
    const finalPosts = finalCombinedPosts.slice(0, 20).map(post => {
      return {
        ...post,
        timestamp: post.timestamp._seconds * 1000,
        starExpiryTimestamp: post.starExpiryTimestamp ? post.starExpiryTimestamp._seconds * 1000 : null,
      };
    });

    return finalPosts;

  } catch (error) {
    console.error("Habaye ikosa mu gutegura feed:", error);
    throw new functions.https.HttpsError('internal', 'Habaye ikosa ridasanzwe.');
  }
});

// =========================================================================
// ----> IGIKORWA #1: GUHARURA 'HOT SCORE' <----
// =========================================================================
exports.calculateHotScore = functions.firestore
  .document("posts/{postId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) {
      return null;
    }
    const postData = change.after.data();
    let effectiveLikes;
    const isNewPost = !change.before.exists;
    if (isNewPost) {
      effectiveLikes = 5; 
    } else {
      effectiveLikes = postData.likes || 0;
    }
    if (!postData.timestamp) {
      return null;
    }
    const postTimestamp = postData.timestamp.toDate();
    const now = new Date();
    const ageInMillis = now.getTime() - postTimestamp.getTime();
    const ageInHours = ageInMillis / (1000 * 60 * 60);
    const gravity = 1.8;
    const newHotScore = effectiveLikes / Math.pow(ageInHours + 2, gravity);
    const oldHotScore = postData.hotScore || 0;
    if (Math.abs(newHotScore - oldHotScore) < 0.0001) {
      return null;
    }
    return change.after.ref.update({ hotScore: newHotScore });
  });

// =========================================================================
// ----> FUNCTIONS ZAWE Z'UMWIMERERE, ZIGUMA UKO ZARI <----
// =========================================================================

exports.handleMediaOptimization = functions
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .storage.object().onFinalize(async (object) => {
    const filePath = object.name;
    const contentType = object.contentType;
    const metadata = object.metadata || {};

    if (path.basename(filePath).startsWith("optimized_")) {
      return null;
    }

    if (filePath.startsWith("posts/")) {
      const isVideo = contentType.startsWith("video/");
      const isImage = contentType.startsWith("image/");
      if (!isVideo && !isImage) return null;
      
      const fileName = path.basename(filePath);
      const tempFilePath = path.join(os.tmpdir(), fileName);
      
      const optimizedExtension = isVideo ? ".mp4" : ".webp";
      const optimizedContentType = isVideo ? "video/mp4" : "image/webp";
      const optimizedFileName = "optimized_" + path.parse(fileName).name + optimizedExtension;
      const tempOptimizedPath = path.join(os.tmpdir(), optimizedFileName);
      const optimizedFilePath = path.join(path.dirname(filePath), optimizedFileName);

      try {
        await bucket.file(filePath).download({ destination: tempFilePath });

        if (isVideo) {
          await new Promise((resolve, reject) => {
            spawn(ffmpeg_static, ['-i', tempFilePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', tempOptimizedPath])
            .on('close', resolve).on('error', reject);
          });
        } else {
          await sharp(tempFilePath).webp({ quality: 80 }).toFile(tempOptimizedPath);
        }

        await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: optimizedContentType } });
        const [newUrl] = await bucket.file(optimizedFilePath).getSignedUrl({ action: 'read', expires: '03-09-2491' });
        
        const originalName = path.parse(fileName).name;
        const isThumbnail = originalName.includes('_thumbnail');
        const postId = isThumbnail ? originalName.split('_thumbnail')[0] : originalName;
        
        const postRef = db.collection('posts').doc(postId);
        
        let updateData;
        if (isThumbnail) {
          updateData = { thumbnailUrl: newUrl };
        } else if (isVideo) {
          updateData = { videoUrl: newUrl, videoStoragePath: optimizedFilePath };
        } else {
          updateData = { imageUrl: newUrl, imageStoragePath: optimizedFilePath };
        }
        await postRef.update(updateData);

      } catch (error) {
        console.error(`Habaye ikosa mu gutunganya media ya POST (${filePath}):`, error);
      } finally {
        if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
        await bucket.file(filePath).delete();
      }
      return null;
    }

    if (filePath.startsWith("chat_media/")) {
      const isVideo = contentType.startsWith("video/");
      const isImage = contentType.startsWith("image/");
      
      if (!isVideo && !isImage) return null;

      const { chatRoomID, messageID, receiverID } = metadata.customMetadata || {};
      if (!chatRoomID || !messageID || !receiverID) {
          return null;
      }
      
      const fileName = path.basename(filePath);
      const tempFilePath = path.join(os.tmpdir(), fileName);

      const optimizedExtension = isVideo ? ".mp4" : ".webp";
      const optimizedContentType = isVideo ? "video/mp4" : "image/webp";
      const optimizedFileName = "optimized_" + path.parse(fileName).name + optimizedExtension;
      const tempOptimizedPath = path.join(os.tmpdir(), optimizedFileName);
      const optimizedFilePath = path.join(path.dirname(filePath), optimizedFileName);

      try {
          await bucket.file(filePath).download({ destination: tempFilePath });

          if (isVideo) {
            await new Promise((resolve, reject) => {
              spawn(ffmpeg_static, ['-i', tempFilePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', tempOptimizedPath])
              .on('close', resolve).on('error', reject);
            });
          } else {
            await sharp(tempFilePath).webp({ quality: 80 }).toFile(tempOptimizedPath);
          }
          
          await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: optimizedContentType, metadata } });
          const [newUrl] = await bucket.file(optimizedFilePath).getSignedUrl({ action: 'read', expires: '03-09-2491' });
          
          const messageRef = db.collection('chat_rooms').doc(chatRoomID).collection('messages').doc(messageID);
          await messageRef.update({ fileUrl: newUrl, storagePath: optimizedFilePath });
          
          await sendMediaUpdateNotification(receiverID, messageID, chatRoomID, newUrl, optimizedFilePath);

      } catch (error) {
          console.error(`Habaye ikosa mu gutunganya media ya CHAT (${filePath}):`, error);
      } finally {
          if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
          await bucket.file(filePath).delete();
      }
      return null;
    }

    return null;
  });

exports.deleteOldRegularPosts = functions.pubsub
  .schedule("every 1 hours")
  .onRun(async (context) => {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    const oldPostsQuery = db.collection("posts").where("isStar", "==", false).where("timestamp", "<", admin.firestore.Timestamp.fromDate(twentyFourHoursAgo));
    const snapshot = await oldPostsQuery.get();
    if (snapshot.empty) return null;
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    return null;
  });

exports.unstarOldStars = functions.pubsub
  .schedule("every day 17:55")
  .timeZone("Africa/Bujumbura")
  .onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();
    const oldStarsQuery = db.collection("posts").where("isStar", "==", true).where("starExpiryTimestamp", "<", now);
    const snapshot = await oldStarsQuery.get();
    if (snapshot.empty) {
      return null;
    }
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      const postRef = db.collection("posts").doc(doc.id);
      batch.update(postRef, { isStar: false });
    });
    await batch.commit();
    return null;
  });

exports.calculateAndAssignStars = functions.pubsub
  .schedule("every day 18:00")
  .timeZone("Africa/Bujumbura")
  .onRun(async (context) => {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const postsQuery = db.collection("posts").where("timestamp", ">=", admin.firestore.Timestamp.fromDate(twentyFourHoursAgo));
    const snapshot = await postsQuery.get();
    if (snapshot.empty) {
      return null;
    }
    const postsWithScore = snapshot.docs.map((doc) => {
      const data = doc.data();
      const likes = data.likes || 0;
      const postTimestamp = data.timestamp.toDate();
      const ageInMillis = now.getTime() - postTimestamp.getTime();
      const ageInHours = ageInMillis / (1000 * 60 * 60);
      const score = likes / Math.pow(ageInHours + 2, 1.8);
      return { id: doc.id, score: score };
    });
    postsWithScore.sort((a, b) => b.score - a.score);
    const top5Stars = postsWithScore.slice(0, 5);
    if (top5Stars.length === 0) return null;

    const batch = db.batch();
    const expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const starExpiryTimestamp = admin.firestore.Timestamp.fromDate(expiryDate);
    
    top5Stars.forEach((post) => {
      const postRef = db.collection("posts").doc(post.id);
      batch.update(postRef, { isStar: true, starExpiryTimestamp: starExpiryTimestamp });
    });
    await batch.commit();
    return null;
  });

exports.sendStarNotification = functions.firestore
  .document("posts/{postId}")
  .onUpdate(async (change, context) => {
    const dataBefore = change.before.data();
    const dataAfter = change.after.data();

    if (dataBefore.isStar === false && dataAfter.isStar === true) {
      const userId = dataAfter.userId;
      const postId = context.params.postId;
      if (!userId) return null;

      const notificationTitle = "Wakoze Neza, Wabaye Star Wacu ⭐!";
      const notificationBody = "Ijambo ryawe ryakoze kumitima y'abenshi. Post yawe yabaye muri zitanu nziza mumasaha 24 aheze! Igiye rero kumara ayandi masaha 24 mu kibanza categekanirijwe aba Stars ⭐ kugira n'abandi babone iciyumviro cawe kidasanzwe. TURAGUKEJE RERO STAR WACU ⭐! Jembe Talk yemerewe kwifashisha iyi post yawe mu kwamamaza ibikorwa vyayo. (TANGAZA STAR⭐)";
      
      const notificationRef = db.collection("notifications"); 
      await notificationRef.add({
        userId: userId,
        title: notificationTitle,
        body: notificationBody,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        isRead: false,
        relatedPostId: postId,
        type: "star_winner",
      });
    }
    return null;
  });

exports.deleteOldStarNotifications = functions.pubsub
  .schedule("every day 18:01")
  .timeZone("Africa/Bujumbura")
  .onRun(async (context) => {
    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() - 24);
    expiryTime.setMinutes(expiryTime.getMinutes() - 30);
    
    const oldNotificationsQuery = db
      .collection("notifications")
      .where("type", "==", "star_winner")
      .where("timestamp", "<", admin.firestore.Timestamp.fromDate(expiryTime));
      
    const snapshot = await oldNotificationsQuery.get();
    
    if (snapshot.empty) {
      return null;
    }
    
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    return null;
  });

exports.cleanupStorageOnPostDelete = functions.firestore
  .document("posts/{postId}")
  .onDelete(async (snap, context) => {
    return null;
  });

async function sendMediaUpdateNotification(receiverId, messageId, chatRoomId, newUrl, newPath) {
    if (!receiverId) {
      return;
    }
    try {
      const userDoc = await db.collection("users").doc(receiverId).get();
      if (!userDoc.exists || !userDoc.data()?.fcmToken) {
        return;
      }
      const fcmToken = userDoc.data().fcmToken;
      const payload = {
        token: fcmToken,
        data: {
          type: "media_optimized",
          messageId: messageId,
          chatRoomId: chatRoomId,
          newFileUrl: newUrl,
          newStoragePath: newPath,
        },
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" } },
      };
      await admin.messaging().send(payload);
    } catch (error) {
      console.error(`Failed to send FCM for message ${messageId}:`, error);
    }
  }

exports.blockChatMessageOnCreate = functions.firestore
  .document("chat_rooms/{chatRoomId}/messages/{messageId}")
  .onCreate(async (snap, context) => {
    const messageData = snap.data();
    const senderId = messageData.senderID;
    const receiverId = messageData.receiverID;
    if (!senderId || !receiverId) {
      return null;
    }
    try {
      const receiverDoc = await db.collection("users").doc(receiverId).get();
      if (receiverDoc.exists) {
        const receiverData = receiverDoc.data();
        const blockedUsers = receiverData.blockedUsers || [];
        if (blockedUsers.includes(senderId)) {
          await snap.ref.delete();
          return null;
        }
      }
    } catch (error) {
      console.error(`Habaye ikosa mu kugenzura status ya block kuri ${receiverId}:`, error);
    }
    return null;
  });