const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;

export async function startGeminiSession() {
  const listeners = {
    partial: [],
    response: [],
    error: [],
  };

  let closed = false;

  function emitPartial(p) {
    listeners.partial.forEach((l) => l(p));
  }
  function emitResponse(r) {
    listeners.response.forEach((l) => l(r));
  }
  function emitError(e) {
    listeners.error.forEach((l) => l(e));
  }

  async function sendAudioChunk(base64Pcm) {
    if (closed) return;
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    inline_data: {
                      mime_type: "audio/pcm;rate=16000",
                      data: base64Pcm,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.7,
            },
          }),
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        emitError(new Error(`Gemini API error: ${resp.status} ${text}`));
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Cada evento vem em linhas "data: {...}"
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const jsonStr = line.replace("data:", "").trim();
            if (jsonStr === "[DONE]") continue;

            try {
              const data = JSON.parse(jsonStr);

              // Exemplo de payload esperado
              if (data.candidates) {
                for (const cand of data.candidates) {
                  if (cand.content?.parts) {
                    for (const part of cand.content.parts) {
                      if (part.text) {
                        emitPartial(part.text); // texto parcial
                      }
                    }
                  }
                }
              }

              if (data.finished) {
                emitResponse(data); // resposta final completa
              }
            } catch (err) {
              emitError(err);
            }
          }
        }
      }
    } catch (err) {
      emitError(err);
    }
  }

  async function sendEndOfUtterance() {
    // Dependendo da API, pode ser necessário mandar um prompt vazio
    // ou apenas não enviar mais chunks para forçar fechamento.
    emitResponse({ done: true });
  }

  function close() {
    closed = true;
  }

  return {
    onPartial: (cb) => listeners.partial.push(cb),
    onResponse: (cb) => listeners.response.push(cb),
    onError: (cb) => listeners.error.push(cb),
    sendAudioChunk,
    sendEndOfUtterance,
    close,
  };
}

// Wrappers externos para usar no WebSocket
export async function sendAudioChunk(session, base64) {
  return session.sendAudioChunk(base64);
}

export async function sendEndOfUtterance(session) {
  return session.sendEndOfUtterance();
}
