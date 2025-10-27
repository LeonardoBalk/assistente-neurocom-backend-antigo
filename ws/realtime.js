import { WebSocketServer } from "ws";
import {
  startGeminiSession,
  sendAudioChunk,
  sendEndOfUtterance,
} from "../services/geminiRealtime.js";

export function createRealtimeWSS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/voice") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", async (ws) => {
    console.log("[WS] Nova conexão de voz");

    const geminiSession = await startGeminiSession();

    geminiSession.onPartial((partial) => {
      ws.send(JSON.stringify({ type: "partial_transcript", data: partial }));
    });

    geminiSession.onResponse((resp) => {
      ws.send(JSON.stringify({ type: "model_response", data: resp }));
    });

    geminiSession.onError((err) => {
      ws.send(
        JSON.stringify({ type: "error", error: err?.message || String(err) })
      );
    });

    ws.on("message", async (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());

        if (parsed.type === "audio_chunk") {
          await sendAudioChunk(geminiSession, parsed.data); // Base64 PCM
        } else if (parsed.type === "end_of_utterance") {
          await sendEndOfUtterance(geminiSession);
        } else if (parsed.type === "close") {
          ws.close();
        }
      } catch (e) {
        console.error("Erro ao processar mensagem WS:", e);
      }
    });

    ws.on("close", () => {
      geminiSession.close();
      console.log("[WS] Conexão encerrada");
    });
  });

  return wss;
}
