import "dotenv/config";

import express from "express";
import pino from "pino";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 3000);

const AUTH_FOLDER =
  process.env.AUTH_FOLDER || "/data/auth_info";

const PAIRING_PHONE_NUMBER = String(
  process.env.PAIRING_PHONE_NUMBER || ""
).replace(/\D/g, "");

const STICKER_LIMIT = Number(
  process.env.STICKER_LIMIT || 5
);

const STICKER_WINDOW_SECONDS = Number(
  process.env.STICKER_WINDOW_SECONDS || 30
);

const STICKER_WINDOW_MS =
  STICKER_WINDOW_SECONDS * 1000;

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

let sock = null;
let isStarting = false;

/*
 * tracker:
 * key = groupJid:userJid
 * value = array of timestamps
 */
const stickerTracker = new Map();

function isGroup(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function unwrapMessage(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message
  );
}

function getSenderJid(message) {
  return (
    message?.key?.participant ||
    message?.participant ||
    null
  );
}

function getBotJid() {
  return sock?.user?.id || null;
}

function isStickerMessage(message) {
  const content = unwrapMessage(message?.message);

  return Boolean(content?.stickerMessage);
}

function cleanJid(jid) {
  if (!jid) return "";

  return jid.split(":")[0].split("/")[0];
}

function sameJid(firstJid, secondJid) {
  return cleanJid(firstJid) === cleanJid(secondJid);
}

async function isUserAdmin(groupJid, userJid) {
  const metadata = await sock.groupMetadata(groupJid);

  const participant = metadata.participants.find((item) => {
    return sameJid(item.id, userJid);
  });

  return Boolean(
    participant?.admin === "admin" ||
    participant?.admin === "superadmin"
  );
}

function getRecentStickerTimestamps(trackerKey, now) {
  const oldTimestamps =
    stickerTracker.get(trackerKey) || [];

  return oldTimestamps.filter((timestamp) => {
    return now - timestamp <= STICKER_WINDOW_MS;
  });
}

async function removeUserFromGroup(groupJid, userJid) {
  await sock.groupParticipantsUpdate(
    groupJid,
    [userJid],
    "remove"
  );
}

async function handleStickerMessage(message) {
  const groupJid = message?.key?.remoteJid;
  const userJid = getSenderJid(message);

  if (!isGroup(groupJid)) {
    return;
  }

  if (!userJid) {
    return;
  }

  const botJid = getBotJid();

  if (botJid && sameJid(userJid, botJid)) {
    return;
  }

  try {
    const userIsAdmin = await isUserAdmin(
      groupJid,
      userJid
    );

    if (userIsAdmin) {
      console.log(
        `Ignored sticker from group admin: ${userJid}`
      );
      return;
    }
  } catch (error) {
    console.error(
      "Could not read group members:",
      error?.message || error
    );

    return;
  }

  const now = Date.now();
  const trackerKey = `${groupJid}:${userJid}`;

  const recentTimestamps =
    getRecentStickerTimestamps(trackerKey, now);

  recentTimestamps.push(now);

  stickerTracker.set(
    trackerKey,
    recentTimestamps
  );

  console.log(
    `Sticker count: ${userJid} = ` +
      `${recentTimestamps.length}/${STICKER_LIMIT + 1}`
  );

  if (recentTimestamps.length <= STICKER_LIMIT) {
    return;
  }

  try {
    await removeUserFromGroup(
      groupJid,
      userJid
    );

    stickerTracker.delete(trackerKey);

    const mentionName = userJid.split("@")[0];

    await sock.sendMessage(groupJid, {
      text:
        `تم طرد العضو @${mentionName}.\n` +
        `السبب: إرسال أكثر من ${STICKER_LIMIT} ` +
        `ستيكرات خلال ${STICKER_WINDOW_SECONDS} ثانية.`,
      mentions: [userJid]
    });

    console.log(
      `Removed ${userJid} from ${groupJid}`
    );
  } catch (error) {
    console.error(
      "Could not remove user:",
      error?.message || error
    );

    await sock.sendMessage(groupJid, {
      text:
        "لقيت عضو كيرسل ستيكرات بزاف، " +
        "ولكن ما قدرتش نطردو.\n\n" +
        "تأكد أن البوت Admin فهاد الكروب."
    });
  }
}

async function sendHelp(groupJid) {
  await sock.sendMessage(groupJid, {
    text:
      "بوت مراقبة الستيكارات خدام.\n\n" +
      `القانون الحالي: أكثر من ${STICKER_LIMIT} ` +
      `ستيكرات خلال ${STICKER_WINDOW_SECONDS} ثانية ` +
      `كيؤدي للطرد.\n\n` +
      "الأدمنز مستثنيين من القانون."
  });
}

async function handleIncomingMessage(message) {
  if (!message) {
    return;
  }

  if (message.key?.fromMe) {
    return;
  }

  if (!message.message) {
    return;
  }

  const remoteJid = message.key?.remoteJid;

  if (!isGroup(remoteJid)) {
    return;
  }

  if (isStickerMessage(message)) {
    await handleStickerMessage(message);
    return;
  }

  const content = unwrapMessage(message.message);

  const text =
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    "";

  if (text.trim().toLowerCase() === "!help") {
    await sendHelp(remoteJid);
  }
}

async function connectWhatsApp() {
  if (isStarting) {
    return;
  }

  isStarting = true;

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_FOLDER);

    const {
      version
    } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: [
        "Sticker Moderator",
        "Chrome",
        "1.0.0"
      ],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect
        } = update;

        if (connection === "connecting") {
          console.log(
            "Connecting to WhatsApp..."
          );
        }

        if (connection === "open") {
          console.log(
            "WhatsApp connected successfully."
          );
        }

        if (connection !== "close") {
          return;
        }

        const statusCode =
          lastDisconnect?.error?.output
            ?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        console.log(
          "WhatsApp connection closed.",
          {
            statusCode,
            loggedOut
          }
        );

        if (loggedOut) {
          console.log(
            "WhatsApp logged out. Delete the auth " +
              "folder and pair again."
          );

          return;
        }

        await sleep(5000);

        isStarting = false;
        await connectWhatsApp();
      }
    );

    if (!state.creds.registered) {
      if (!PAIRING_PHONE_NUMBER) {
        throw new Error(
          "PAIRING_PHONE_NUMBER غير موجود."
        );
      }

      await sleep(3000);

      const pairingCode =
        await sock.requestPairingCode(
          PAIRING_PHONE_NUMBER
        );

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "WhatsApp Pairing Code:"
      );
      console.log(pairingCode);
      console.log(
        "========================================"
      );
      console.log("");
      console.log(
        "في الهاتف افتح WhatsApp ثم:"
      );
      console.log(
        "الأجهزة المرتبطة > ربط جهاز > " +
          "الربط برقم الهاتف"
      );
      console.log("");
    }

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {
        for (const message of messages || []) {
          try {
            await handleIncomingMessage(message);
          } catch (error) {
            console.error(
              "Message handling error:",
              error?.message || error
            );
          }
        }
      }
    );
  } catch (error) {
    console.error(
      "WhatsApp startup error:",
      error?.message || error
    );

    isStarting = false;

    await sleep(10000);
    await connectWhatsApp();
  }
}

/*
 * HTTP server required by Railway.
 */
const app = express();

app.get("/", (request, response) => {
  response.status(200).json({
    ok: true,
    service: "whatsapp-sticker-moderator",
    stickerLimit: STICKER_LIMIT,
    stickerWindowSeconds: STICKER_WINDOW_SECONDS
  });
});

app.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    whatsappStarted: Boolean(sock)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `HTTP server listening on port ${PORT}`
  );

  console.log(
    `Sticker rule: more than ${STICKER_LIMIT} ` +
      `stickers in ${STICKER_WINDOW_SECONDS} seconds`
  );

  connectWhatsApp().catch((error) => {
    console.error(
      "Fatal WhatsApp error:",
      error?.message || error
    );
  });
});
  
