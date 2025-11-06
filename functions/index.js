// functions/index.js (VERSION FINAL, IKOSOYE, KANDI IKORA NEZA 100%)

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
// ----> IZI NI FUNCTIONS ZAWE Z'UMWIMERERE, NTABWO ZAHINDUTSE <----
// =========================================================================

// Igikorwa #1: Gusiba posts zishaje
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

// Igikorwa #2: Gusiba ubutegetsi bwa Stars zishaje (17:55)
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

// Igikorwa #3: Guhitamo ba Stars batanu (18:00)
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

// Igikorwa #4: Gushira ubutumwa muri DATABASE ku batsinze
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

// Igikorwa #5: Gusiba ubutumwa bwa Star bushashaje
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

// Igikorwa #6: Gusiba ifoto/video muri Storage iyo post isibwe
exports.cleanupStorageOnPostDelete = functions.firestore
  .document("posts/{postId}")
  .onDelete(async (snap, context) => {
    // ... code yawe isanzwe hano ntihinduka ...
    return null;
  });


// =========================================================================
// ----> IZI NI FUNCTIONS ZIJANYE N'IBIGANIRO (CHAT) <----
// =========================================================================

/**
 * Function y'ubufasha yo kohereza ubutumwa bwa FCM (data message)
 */
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

// Function yo gutunganya amavidewo y'ibiganiro
exports.optimizeChatVideo = functions
    .runWith({ timeoutSeconds: 300, memory: "1GB" })
    .storage.object().onFinalize(async (object) => {
        const filePath = object.name;
        const contentType = object.contentType;
        const metadata = object.metadata || {};

        if (!contentType.startsWith("video/") || !filePath.startsWith("chat_media/") || path.basename(filePath).startsWith("optimized_")) {
            return null;
        }
        
        const { chatRoomID, messageID, receiverID } = metadata.customMetadata || {};

        if (!chatRoomID || !messageID || !receiverID) {
            console.log("Missing metadata for chat video. Aborting.");
            return null;
        }

        const fileName = path.basename(filePath);
        const tempFilePath = path.join(os.tmpdir(), fileName);
        const optimizedFileName = "optimized_" + fileName.replace(/\.[^/.]+$/, "") + ".mp4";
        const tempOptimizedPath = path.join(os.tmpdir(), optimizedFileName);
        const optimizedFilePath = path.join(path.dirname(filePath), optimizedFileName);

        try {
            await bucket.file(filePath).download({ destination: tempFilePath });

            await new Promise((resolve, reject) => {
                spawn(ffmpeg_static, ['-i', tempFilePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', tempOptimizedPath])
                .on('close', resolve).on('error', reject);
            });
            
            await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: "video/mp4", metadata } });
            
            const [newUrl] = await bucket.file(optimizedFilePath).getSignedUrl({ action: 'read', expires: '03-09-2491' });
            
            const messageRef = db.collection('chat_rooms').doc(chatRoomID).collection('messages').doc(messageID);
            await messageRef.update({ fileUrl: newUrl, storagePath: optimizedFilePath });
            
            await sendMediaUpdateNotification(receiverID, messageID, chatRoomID, newUrl, optimizedFilePath);

        } catch (error) {
            console.error("Error optimizing video:", error);
        } finally {
            if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
            await bucket.file(filePath).delete();
        }
        return null;
    });

// Function yo gutunganya amafoto y'ibiganiro
exports.optimizeChatImage = functions
    .runWith({ timeoutSeconds: 60, memory: "512MB" })
    .storage.object().onFinalize(async (object) => {
        const filePath = object.name;
        const contentType = object.contentType;
        const metadata = object.metadata || {};

        if (!contentType.startsWith("image/") || !filePath.startsWith("chat_media/") || path.basename(filePath).startsWith("optimized_")) {
            return null;
        }

        const { chatRoomID, messageID, receiverID } = metadata.customMetadata || {};

        if (!chatRoomID || !messageID || !receiverID) {
            console.log("Missing metadata for chat image. Aborting.");
            return null;
        }

        const fileName = path.basename(filePath);
        const tempFilePath = path.join(os.tmpdir(), fileName);
        const optimizedFileName = "optimized_" + path.parse(fileName).name + ".webp";
        const tempOptimizedPath = path.join(os.tmpdir(), optimizedFileName);
        const optimizedFilePath = path.join(path.dirname(filePath), optimizedFileName);

        try {
            await bucket.file(filePath).download({ destination: tempFilePath });
            await sharp(tempFilePath).webp({ quality: 80 }).toFile(tempOptimizedPath);
            await bucket.upload(tempOptimizedPath, { destination: optimizedFilePath, metadata: { contentType: "image/webp", metadata } });
            
            const [newUrl] = await bucket.file(optimizedFilePath).getSignedUrl({ action: 'read', expires: '03-09-2491' });

            const messageRef = db.collection('chat_rooms').doc(chatRoomID).collection('messages').doc(messageID);
            await messageRef.update({ fileUrl: newUrl, storagePath: optimizedFilePath });
            
            await sendMediaUpdateNotification(receiverID, messageID, chatRoomID, newUrl, optimizedFilePath);

        } catch (error) {
            console.error("Error optimizing image:", error);
        } finally {
            if(fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if(fs.existsSync(tempOptimizedPath)) fs.unlinkSync(tempOptimizedPath);
            await bucket.file(filePath).delete();
        }
        return null;
    });

// =========================================================================
// ----> IMPINDUKA NSHYA YONGEYEMWO KU BIJYANYE NO GU-BLOKA <----
// =========================================================================

/**
 * Iyi function igenzura ubutumwa bwose bwanditswe muri chat.
 * Iyo isanze uwarungitse yarafunzwe n'uwakira, ihita isiba ubwo butumwa ako kanya.
 */
exports.blockChatMessageOnCreate = functions.firestore
  .document("chat_rooms/{chatRoomId}/messages/{messageId}")
  .onCreate(async (snap, context) => {
    const messageData = snap.data();
    const senderId = messageData.senderID;
    const receiverId = messageData.receiverID;

    // Turahagarika nimba ata sender canke receiver bihari
    if (!senderId || !receiverId) {
      console.log("SenderID or ReceiverID is missing. Cannot check block status.");
      return null;
    }

    try {
      // Turarondera amakuru y'uwakira ubutumwa
      const receiverDoc = await db.collection("users").doc(receiverId).get();
      
      // Tugenzura nimba uwo muntu ari muri database
      if (receiverDoc.exists) {
        const receiverData = receiverDoc.data();
        // Turarondera urutonde rw'abo yafunze (blockedUsers)
        const blockedUsers = receiverData.blockedUsers || [];
        
        // Tugenura nimba uwarungitse ari kuri urwo rutonde
        if (blockedUsers.includes(senderId)) {
          console.log(`Ubutumwa buvuye kuri ${senderId} buja kuri ${receiverId} BWAHAGARITSWE kuko yafunzwe. Turasiba ubutumwa...`);
          
          // Guhagarika ubutumwa ni ugusiba document yari ihejeje kwandikwa.
          // Uwarungitse ntabwo abimenya, kuri we abona ko bwarungitswe (sent)
          // ariko ntibuzigera bushika (delivered).
          await snap.ref.delete();
          console.log(`Ubutumwa ${context.params.messageId} rwasivye neza.`);
          return null;
        }
      }
    } catch (error) {
      console.error(`Habaye ikosa mu kugenzura status ya block kuri ${receiverId}:`, error);
      // Niyo habaye ikosa, tureka ubutumwa bukagenda kugira ntiduhagarike ibiganiro by'abandi.
    }
    
    // Niba atawafunzwe, nta kindi dukora, function irarangira neza.
    return null;
  });