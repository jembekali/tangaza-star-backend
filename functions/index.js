// functions/index.js (VERSION YAKOSOWE NEZA IKEMURA IKIBABZO CY'URUZIGA)

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
// ----> FUNCTION YO GUTUNGANYA MEDIA (NTIYAhindutse) <----
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
      console.log(`Media nshya ya POST yabonetse: ${filePath}. Dutangiye kuyitunganya...`);
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
        const postId = path.basename(fileName, path.extname(fileName));
        const postRef = db.collection('posts').doc(postId);
        const updateData = isVideo 
          ? { videoUrl: newUrl, videoStoragePath: optimizedFilePath }
          : { imageUrl: newUrl, imageStoragePath: optimizedFilePath };
        await postRef.update(updateData);
        console.log(`Firestore yahinduwe neza kuri post ${postId}.`);
      } catch (error) {
        console.error(`Habaye ikosa mu gutunganya media ya POST (${filePath}):`, error);
      } finally {
        if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
        await bucket.file(filePath).delete();
        console.log(`File y'umwimerere ${filePath} yasibwe.`);
      }
      return null;
    }

    if (filePath.startsWith("chat_media/")) {
      const isVideo = contentType.startsWith("video/");
      const isImage = contentType.startsWith("image/");
      if (!isVideo && !isImage) return null;
      const { chatRoomID, messageID, receiverID } = metadata.customMetadata || {};
      if (!chatRoomID || !messageID || !receiverID) {
          console.log("Missing metadata for chat media. Aborting.");
          return null;
      }
      console.log(`Media nshya ya CHAT yabonetse: ${filePath}. Dutangiye kuyitunganya...`);
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

// =========================================================================
// ----> IGIKORWA #1: GUHARURA 'HOT SCORE' (IKOSOYE) <----
// =========================================================================
exports.calculateHotScore = functions.firestore
  .document("posts/{postId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) {
      return null;
    }
    const postData = change.after.data();
    const postId = context.params.postId;
    const likes = postData.likes || 0;
    
    if (!postData.timestamp) {
      console.log(`Post ${postId} ntiragira timestamp, turaretse gato...`);
      return null;
    }

    const postTimestamp = postData.timestamp.toDate();
    const now = new Date();
    const ageInMillis = now.getTime() - postTimestamp.getTime();
    const ageInHours = ageInMillis / (1000 * 60 * 60);
    const gravity = 1.8;
    const newHotScore = likes / Math.pow(ageInHours + 2, gravity);
    
    // <<<--- IKI NI CYO CYAHINDUTSE: Ubu turagereranya neza score ya kera n'inshya ---<<<
    const oldHotScore = postData.hotScore || 0;

    // Turahagarika niba itandukaniro riri hasi cane kugira twirinde uruziga (infinite loop)
    if (Math.abs(newHotScore - oldHotScore) < 0.0001) {
      return null;
    }

    console.log(`Guhindura Hot Score ya post ${postId}: ${newHotScore}`);
    return change.after.ref.update({ hotScore: newHotScore });
  });

// =========================================================================
// ----> FUNCTIONS ZAWE Z'UMWIMERERE (NTIZAHINDUTSE) <----
// =========================================================================

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
    console.log(`Deleted ${snapshot.size} old posts.`);
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
      console.log("Nta Star ishaje yabonetse yo gusiba ubutegetsi.");
      return null;
    }
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      const postRef = db.collection("posts").doc(doc.id);
      batch.update(postRef, { isStar: false });
    });
    await batch.commit();
    console.log(`Zasubijwe uko zari: ${snapshot.size} posts zasivye kuba Star.`);
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
      console.log("Nta post nshasha yabonetse yo kuronderamwo Stars.");
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
    console.log(`Hatoranijwe Stars ${top5Stars.length} hakoreshejwe Hot Score.`);
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
      console.log(`Ubutumwa bwa Star bwashizwe muri database kuri user: ${userId}`);
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
      console.log("Nta butumwa bwa Star bushashaje bubonetse bwo gusiba.");
      return null;
    }
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    console.log(`Hasivye ubutumwa bwa Star bushashaje ${snapshot.size}.`);
    return null;
  });

exports.cleanupStorageOnPostDelete = functions.firestore
  .document("posts/{postId}")
  .onDelete(async (snap, context) => {
    return null;
  });

async function sendMediaUpdateNotification(receiverId, messageId, chatRoomId, newUrl, newPath) {
    if (!receiverId) {
      console.log("Receiver ID is missing, cannot send FCM.");
      return;
    }
    try {
      const userDoc = await db.collection("users").doc(receiverId).get();
      if (!userDoc.exists || !userDoc.data()?.fcmToken) {
        console.log(`FCM token for user ${receiverId} not found.`);
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
      console.log(`Successfully sent FCM to user ${receiverId} for message ${messageId}.`);
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
      console.log("SenderID or ReceiverID is missing. Cannot check block status.");
      return null;
    }
    try {
      const receiverDoc = await db.collection("users").doc(receiverId).get();
      if (receiverDoc.exists) {
        const receiverData = receiverDoc.data();
        const blockedUsers = receiverData.blockedUsers || [];
        if (blockedUsers.includes(senderId)) {
          console.log(`Ubutumwa buvuye kuri ${senderId} buja kuri ${receiverId} BWAHAGARITSWE kuko yafunzwe. Turasiba ubutumwa...`);
          await snap.ref.delete();
          console.log(`Ubutumwa ${context.params.messageId} rwasivye neza.`);
          return null;
        }
      }
    } catch (error) {
      console.error(`Habaye ikosa mu kugenzura status ya block kuri ${receiverId}:`, error);
    }
    return null;
  });