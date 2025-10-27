// carrega variaveis de ambiente
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import jwt from "jsonwebtoken";
import session from "express-session";
import passport from "passport";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { createRealtimeWSS } from "./ws/realtime.js";
import http from "http";
import cors from "cors";
import { verifyGoogleIdToken } from "./googleToken.js";

// camada rag e chat sem posicao forcada
const app = express();
const SECRET = process.env.JWT_SECRET || "chave";
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
createRealtimeWSS(server);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  db: { schema: "public" },
  global: {
    // nota: fetch nativo nao suporta timeout; se precisar, usar abortcontroller
    fetch: (url, opts) => fetch(url, { ...opts, timeout: 30000 })
  }
});

// inicializa gemini
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// modelos para embedding e chat
const embedModel = gemini.getGenerativeModel({ model: "text-embedding-004" });
const chatModel = gemini.getGenerativeModel({
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
});

// helper central para gerar embeddings
async function embedText(text) {
  const resp = await embedModel.embedContent({
    content: { parts: [{ text }] }
  });
  const vec = resp.embedding?.values || [];
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("embedding vazio");
  }
  if (vec.length !== 768) {
    throw new Error(`embedding dimension mismatch: got ${vec.length}, expected 768`);
  }
  return vec;
}

// prompt direto no estilo implicada (condensado)
function buildImplicadaHeader() {
  return `
Manifesto operacional (resumo):
- finalidade: facilitar implicação do sujeito com a própria presença
- posição: nunca protagonista; atua como dobradiça entre partes vivas
- silêncio: parte ativa; pode propor pausa breve quando fizer sentido
- tempo: ritmo lento; respostas curtas, com espaço para continuar
- linguagem: devolução simbólica e viva, sem floreios ou performar empatia
- propósito: explicitar gesto implicado; mapear tensões e ambivalências
- coletividade: implicar dimensão ética e histórica quando pertinente, sem doutrinar
- simulação: não simular humanidade; reconhecer limites e fontes
- fontes: priorizar materiais do Dr. Sérgio Spritzer
NÃO REPITA O QUE O USUÁRIO JÁ DISSE.

Instruções de resposta (resumo):
- fala como eu, natural e consultiva; frases curtas; evita jargões e formalismos
- consulta antes de afirmar: faz 1 checagem direta quando necessário
- nomeia 1–2 elementos concretos trazidos; evita generalidades
- se faltar base, reconhece o limite e pede elementos concretos
- sem aspas desnecessárias e sem travessão; não simular emoção
- termina, quando fizer sentido, com 1 pergunta curta, viva e consultiva
NÃO REPITA O QUE O USUÁRIO JÁ DISSE.

Domínios e escopo:
- neurologia, transtornos da comunicação, inteligência humana, psicanálise, PNL, hipnose, interações humanas
- se estiver fora do escopo, reconhecer limite e convidar a recolocar a pergunta

Adaptação de voz:
- identifica se o endereçamento é você/ele/nós e espelha esse modo

Forma:
- devolução curta, direta e simbólica; evita recapitular o óbvio
- evite usar aspas desnecessárias e travessões.
- CONVERSA NATURAL, RESPONDA DIRETO, RECAPITULE SÓ SE NECESSÁRIO.
NÃO REPITA O QUE O USUÁRIO JÁ DISSE.
SEJA DIRETO, NÃO REPITA O QUE O USUÁRIO JÁ DISSE.
`.trim();
}

// gera resposta implicada direta (sem posicao fixa)
async function generateRespostaImplicadaDirect({ mensagem, contexto, historico }) {
  const histStr = Array.isArray(historico)
    ? historico
        .map((h) => `usuario: ${h.pergunta}\nassistente: ${h.resposta}`)
        .join("\n\n")
    : "";

  const header = buildImplicadaHeader();
  const prompt =
    `${header}\n\n` +
    (contexto ? `Contexto possivelmente relevante (usar indiretamente, reelaborar):\n${contexto}\n\n` : "") +
    (histStr ? `Histórico recente:\n${histStr}\n\n` : "") +
    `Pergunta atual:\n${mensagem}\n\n` +
    `Responda agora de modo curto, implicado e consultivo; se fizer sentido, finalize com uma pergunta viva.`;

  const result = await chatModel.generateContent([{ text: prompt }]);
  const text = result?.response?.text?.() || result?.response?.text || "";
  return (text || "").trim();
}

// gera perguntas de continuacao curtas e consultivas
async function gerarPerguntasContinuacaoLocal({ baseText, mensagem }) {
  try {
    const prompt =
      "gere 1 a 2 perguntas curtas (ate 140 caracteres), abertas e consultivas, em pt-br, focadas no proximo passo. " +
      "espelhe o modo de enderecamento do usuario (voce/ele/nos). " +
      "evite perguntas genericas ou retoricas; nomeie 1 elemento concreto trazido.\n\n" +
      `mensagem do usuario:\n${mensagem}\n\n` +
      `resposta anterior:\n${baseText}`;

    const result = await chatModel.generateContent([{ text: prompt }]);
    const raw = result?.response?.text?.() || "";
    const linhas = raw
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(linhas));
    return uniq.slice(0, 2).map((s) => s.slice(0, 140));
  } catch {
    return [];
  }
}

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONT_URL || "https://neurocom.netlify.app/login",
    credentials: true
  })
);

app.use(
  session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false
  })
);
app.use(passport.initialize());
app.use(passport.session());

// gera token jwt
function gerarToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: "1h" });
}

// middleware para autenticar token jwt
function autenticarToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ erro: "Token não fornecido" });
  jwt.verify(token, SECRET, (err, usuario) => {
    if (err) return res.status(403).json({ erro: "Token inválido" });
    req.usuario = usuario;
    next();
  });
}

// cria sessao no banco
async function createSession(usuarioId, titulo = null) {
  const { data, error } = await supabase
    .from("sessoes")
    .insert([{ usuario_id: usuarioId, titulo }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// verifica se a sessao pertence ao usuario
async function getSessionIfOwned(sessionId, usuarioId) {
  if (!sessionId) return null;
  const { data, error } = await supabase
    .from("sessoes")
    .select("id, usuario_id, titulo, criado_em")
    .eq("id", sessionId)
    .eq("usuario_id", usuarioId)
    .single();
  if (error) return null;
  return data;
}

// rota de teste
app.get("/teste-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .select("id,nome,email")
      .limit(5);
    if (error) throw error;
    res.json({ ok: true, usuarios: data });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// criar usuario local
app.post("/usuarios", async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: "Nome, email e senha são obrigatórios" });
  }
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .insert([{ nome, email, senha }]) // sugestao: usar hash bcrypt
      .select();
    if (error) throw error;
    const usuario = data[0];
    const token = gerarToken({ id: usuario.id, email: usuario.email, nome: usuario.nome });
    res.json({ usuario, token });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

// login local
app.post("/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: "Email e senha são obrigatórios" });
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .select("*")
      .eq("email", email)
      .single();
    if (error || !data || data.senha !== senha) {
      return res.status(401).json({ erro: "Credenciais inválidas" });
    }
    const token = gerarToken({ id: data.id, nome: data.nome, email: data.email });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// login google
app.post("/auth/google-token", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ erro: "Credential (ID token) é obrigatório" });
    }

    const payload = await verifyGoogleIdToken(credential);
    const { sub: googleSub, email, name, picture, email_verified } = payload;

    if (!email) {
      return res.status(400).json({ erro: "Email não disponível" });
    }
    if (email_verified === false) {
      return res.status(403).json({ erro: "Email Google não verificado" });
    }

    let { data: userByGoogle } = await supabase
      .from("usuarios")
      .select("*")
      .eq("google_id", googleSub)
      .single();

    if (!userByGoogle) {
      const { data: userByEmail } = await supabase
        .from("usuarios")
        .select("*")
        .ilike("email", email)
        .single();

      if (userByEmail && !userByEmail.google_id) {
        const { data: updated, error: upErr } = await supabase
          .from("usuarios")
          .update({
            google_id: googleSub,
            provider: "google",
            nome: userByEmail.nome || name || "Usuário",
            avatar_url: picture || userByEmail.avatar_url
          })
          .eq("id", userByEmail.id)
          .select()
          .single();
        if (upErr) throw upErr;
        userByGoogle = updated;
      } else if (!userByEmail) {
        const { data: created, error: createErr } = await supabase
          .from("usuarios")
          .insert([{
            nome: name || "Usuário",
            email,
            senha: null,
            google_id: googleSub,
            provider: "google",
            avatar_url: picture || null
          }])
          .select()
          .single();
        if (createErr) throw createErr;
        userByGoogle = created;
      }
    }

    const token = gerarToken({
      id: userByGoogle.id,
      email: userByGoogle.email,
      nome: userByGoogle.nome
    });

    res.json({
      token,
      usuario: {
        id: userByGoogle.id,
        nome: userByGoogle.nome,
        email: userByGoogle.email,
        avatar_url: userByGoogle.avatar_url,
        provider: userByGoogle.provider
      }
    });
  } catch (err) {
    console.error("Erro /auth/google-token:", err);
    res.status(401).json({ erro: "Token Google inválido" });
  }
});

// pega dados do usuario logado
app.get("/me", autenticarToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .select("id,nome,email,avatar_url,provider")
      .eq("id", req.usuario.id)
      .single();
    if (error || !data) {
      return res.status(404).json({ erro: "Usuário não encontrado" });
    }
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ erro: "Falha ao obter usuário" });
  }
});

/* ========================= Sessoes ========================= */

app.post("/sessoes", autenticarToken, async (req, res) => {
  try {
    const { titulo } = req.body || {};
    const nova = await createSession(req.usuario.id, titulo || null);
    res.status(201).json({ sessao: nova });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/sessoes", autenticarToken, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("listar_sessoes_ordenadas", {
      p_usuario_id: req.usuario.id
    });
    if (error) throw error;
    return res.json({ sessoes: data || [] });
  } catch (rpcErr) {
    try {
      const { data: sessoes, error: e1 } = await supabase
        .from("sessoes")
        .select("id, titulo, criado_em")
        .eq("usuario_id", req.usuario.id);
      if (e1) throw e1;

      if (!Array.isArray(sessoes) || sessoes.length === 0) {
        return res.json({ sessoes: [] });
      }

      const enriched = await Promise.all(
        sessoes.map(async (s) => {
          const { data: last } = await supabase
            .from("historico")
            .select("criado_em")
            .eq("usuario_id", req.usuario.id)
            .eq("sessao_id", s.id)
            .order("criado_em", { ascending: false })
            .limit(1);
          const ultima =
            Array.isArray(last) && last.length > 0 ? last[0].criado_em : s.criado_em;
          return {
            id: s.id,
            titulo: s.titulo,
            criado_em: s.criado_em,
            ultima_atividade: ultima
          };
        })
      );

      enriched.sort(
        (a, b) => new Date(b.ultima_atividade) - new Date(a.ultima_atividade)
      );

      return res.json({ sessoes: enriched });
    } catch (fallbackErr) {
      console.error("GET /sessoes fallback error:", {
        message: fallbackErr.message,
        details: fallbackErr.details,
        hint: fallbackErr.hint,
        code: fallbackErr.code
      });
      return res.status(500).json({ erro: "Falha ao listar sessões" });
    }
  }
});

app.patch("/sessoes/:id", autenticarToken, async (req, res) => {
  const { id } = req.params;
  const { titulo } = req.body;
  if (!titulo || !titulo.trim()) {
    return res.status(400).json({ erro: "Título é obrigatório" });
  }
  try {
    const sess = await getSessionIfOwned(id, req.usuario.id);
    if (!sess) return res.status(404).json({ erro: "Sessão não encontrada" });

    const { data, error } = await supabase
      .from("sessoes")
      .update({ titulo: titulo.trim() })
      .eq("id", id)
      .eq("usuario_id", req.usuario.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ sessao: data });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ========================= Historico ========================= */

app.get("/chat-historico/:sessionId", autenticarToken, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const sess = await getSessionIfOwned(sessionId, req.usuario.id);
    if (!sess) return res.status(404).json({ erro: "Sessão não encontrada" });

    const { data, error } = await supabase
      .from("historico")
      .select("id, pergunta, resposta, criado_em, sessao_id, followups")
      .eq("usuario_id", req.usuario.id)
      .eq("sessao_id", sessionId)
      .order("id", { ascending: true });
    if (error) throw error;

    res.json({ mensagens: data || [] });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ========================= Debug RAG ========================= */

app.get("/debug/rag-search", autenticarToken, async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    const sessionId = (req.query.sessionId || "").toString();
    const minSimDocs = parseFloat(req.query.minSimDocs ?? "0.30");
    const minSimHist = parseFloat(req.query.minSimHist ?? "0.25");
    const docsK = parseInt(req.query.docsK ?? "8", 10);
    const histK = parseInt(req.query.histK ?? "6", 10);

    if (!q) return res.status(400).json({ erro: "Passe ?q=pergunta para testar." });
    if (!sessionId) return res.status(400).json({ erro: "Passe ?sessionId=<uuid> da sessão." });

    const sess = await getSessionIfOwned(sessionId, req.usuario.id);
    if (!sess) return res.status(404).json({ erro: "Sessão não encontrada" });

    const started = Date.now();
    const vec = await embedText(q);

    let rows = [];
    try {
      const { data, error } = await supabase.rpc("search_docs_and_history", {
        p_query_embedding: vec,
        p_usuario_id: req.usuario.id,
        p_sessao_id: sessionId,
        p_match_count: docsK,
        p_history_count: histK,
        p_min_sim_docs: isNaN(minSimDocs) ? 0.30 : minSimDocs,
        p_min_sim_hist: isNaN(minSimHist) ? 0.25 : minSimHist,
        p_recency_half_life_seconds: 86400,
        p_total_limit: null
      });
      if (error) throw error;
      rows = data || [];
    } catch (e) {
      const { data: docsData, error: mdErr } = await supabase.rpc("match_documents", {
        p_query_embedding: vec,
        p_match_count: docsK,
        p_min_sim: isNaN(minSimDocs) ? 0.30 : minSimDocs,
        p_candidate_pool: 100
      });
      if (mdErr) throw mdErr;
      rows = (docsData || []).map(d => ({
        id: d.id,
        content: d.content,
        similarity: d.similarity,
        tipo: "documento",
        score: d.similarity
      }));
    }

    const tookMs = Date.now() - started;

    const byTipo = (t) =>
      rows
        .filter(r => r.tipo === t)
        .map(r => ({
          id: r.id,
          similarity: r.similarity ?? null,
          score: r.score ?? null,
          preview: (r.content || "").slice(0, 200)
        }));

    return res.json({
      query: q,
      took_ms: tookMs,
      total: rows.length,
      documentos: byTipo("documento"),
      historico: byTipo("historico"),
      raw_top3: rows.slice(0, 3).map(r => ({
        id: r.id,
        tipo: r.tipo,
        sim: r.similarity,
        score: r.score,
        preview: (r.content || "").slice(0, 300)
      }))
    });
  } catch (err) {
    console.error("Erro /debug/rag-search:", err);
    return res.status(500).json({ erro: "Falha no debug RAG" });
  }
});

/* ========================= Chat RAG ========================= */

app.post("/chat-rag", autenticarToken, async (req, res) => {
  let { mensagem, sessionId, gerar_perguntas } = req.body;
  if (!mensagem) return res.status(400).json({ erro: "Mensagem obrigatória" });

  try {
    // garante sessao valida
    let sessao = null;
    if (!sessionId) {
      sessao = await createSession(req.usuario.id);
      sessionId = sessao.id;
    } else {
      sessao = await getSessionIfOwned(sessionId, req.usuario.id);
      if (!sessao) {
        sessao = await createSession(req.usuario.id);
        sessionId = sessao.id;
      }
    }

    // pedido de listagem de ultimas mensagens do usuario
    const lower = mensagem.toLowerCase();
    const pedeUltimas =
      (lower.includes("ultimas") || lower.includes("últimas")) &&
      lower.includes("mensagens") &&
      (lower.includes("enviei") || lower.includes("mandei") || lower.includes("te enviei") || lower.includes("te mandei"));
    if (pedeUltimas) {
      let n = 10;
      const m =
        lower.match(/(\d+)\s+(?:mensagens?|msgs?)/) ||
        lower.match(/(?:últimas?|ultimas?)\s+(\d+)\s+(?:mensagens?|msgs?)/);
      if (m) {
        const parsed = parseInt(m[1] || m[2], 10);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 100) n = parsed;
      }

      const { data: msgs, error: eMsgs } = await supabase
        .from("historico")
        .select("id, pergunta")
        .eq("usuario_id", req.usuario.id)
        .eq("sessao_id", sessionId)
        .order("id", { ascending: false })
        .limit(n);
      if (eMsgs) throw eMsgs;

      const lista = (msgs || []).sort((a, b) => a.id - b.id).map((r) => r.pergunta);
      const resposta =
        `Aqui estão as últimas ${lista.length} mensagens (da mais antiga para a mais recente):\n\n` +
        lista.map((t, i) => `${i + 1}. "${t}"`).join("\n");
      return res.json({ resposta, sessionId });
    }

    // contexto rag
    const contexto = await buscarContextoNoSupabase(mensagem, sessionId, req.usuario.id);

    // pega ultimos 10 turnos do historico
    const { data: histData } = await supabase
      .from("historico")
      .select("id, pergunta, resposta")
      .eq("usuario_id", req.usuario.id)
      .eq("sessao_id", sessionId)
      .order("id", { ascending: false })
      .limit(10);

    const historicoCronologico = Array.isArray(histData)
      ? [...histData].sort((a, b) => a.id - b.id)
      : [];

    // gera resposta implicada
    const respostaRaw = await generateRespostaImplicadaDirect({
      mensagem,
      contexto,
      historico: historicoCronologico
    });

    const respostaFinal = respostaRaw;

    // perguntas de continuacao
    let followups = [];
    if (gerar_perguntas !== false) {
      try {
        followups = await gerarPerguntasContinuacaoLocal({
          baseText: respostaFinal,
          mensagem
        });
      } catch (e) {
        console.warn("falha ao gerar perguntas de continuacao:", e?.message);
      }
    }

    // salva historico com embedding
    try {
      const histEmbeddingText = `${mensagem}\n${respostaFinal}`;
      const histVec = await embedText(histEmbeddingText);

      const { data: insRpc, error: insRpcErr } = await supabase.rpc("insert_historico", {
        p_usuario_id: req.usuario.id,
        p_sessao_id: sessionId,
        p_pergunta: mensagem,
        p_resposta: respostaFinal,
        p_embedding: histVec
      });

      if (insRpcErr) {
        const { error: insErr } = await supabase.from("historico").insert([
          {
            usuario_id: req.usuario.id,
            sessao_id: sessionId,
            pergunta: mensagem,
            resposta: respostaFinal,
            followups
          }
        ]);
        if (insErr) throw insErr;
      } else {
        try {
          await supabase
            .from("historico")
            .update({ followups })
            .eq("id", insRpc);
        } catch {}
      }
    } catch (e) {
      console.warn("falha ao salvar historico com embedding; tentando insert minimo.", e?.message);
      await supabase.from("historico").insert([
        {
          usuario_id: req.usuario.id,
          sessao_id: sessionId,
          pergunta: mensagem,
          resposta: respostaFinal,
          followups
        }
      ]);
    }

    // define titulo na primeira mensagem
    try {
      if (!sessao.titulo || !sessao.titulo.trim()) {
        const { count } = await supabase
          .from("historico")
          .select("*", { count: "exact", head: true })
          .eq("usuario_id", req.usuario.id)
          .eq("sessao_id", sessionId);
        if (count === 1) {
          await supabase
            .from("sessoes")
            .update({ titulo: mensagem.slice(0, 60) })
            .eq("id", sessionId)
            .eq("usuario_id", req.usuario.id);
        }
      }
    } catch {}

    res.json({
      resposta: respostaFinal,
      sessionId,
      followups
    });
  } catch (error) {
    console.error("Erro no chat-rag:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code
    });
    res.status(500).json({ erro: "Falha ao processar pergunta" });
  }
});

/* ========================= RAG helper ========================= */

async function buscarContextoNoSupabase(pergunta, sessionId, usuarioId) {
  try {
    const vector = await embedText(pergunta);

    try {
      const { data, error } = await supabase.rpc("search_docs_and_history", {
        p_query_embedding: vector,
        p_usuario_id: usuarioId,
        p_sessao_id: sessionId,
        p_match_count: 8,
        p_history_count: 6,
        p_min_sim_docs: 0.30,
        p_min_sim_hist: 0.25,
        p_recency_half_life_seconds: 86400,
        p_total_limit: null
      });
      if (error) throw error;

      const historicos = (data || [])
        .filter((r) => r.tipo === "historico")
        .map((r) => r.content);
      const docs = (data || [])
        .filter((r) => r.tipo === "documento")
        .map((r) => r.content);

      return [...historicos, ...docs].join("\n");
    } catch (rpcErr) {
      console.warn("rpc search_docs_and_history falhou, usando fallback:", rpcErr.message);
    }

    let docs = [];
    try {
      const { data: docsData, error: mdErr } = await supabase.rpc("match_documents", {
        p_query_embedding: vector,
        p_match_count: 8,
        p_min_sim: 0.30,
        p_candidate_pool: 50
      });
      if (mdErr) throw mdErr;
      if (Array.isArray(docsData)) {
        docs = docsData.map((d) => d.content).filter(Boolean);
      }
    } catch (e) {
      console.warn("fallback match_documents falhou:", e?.message);
    }

    let hist = [];
    try {
      const { data: h } = await supabase
        .from("historico")
        .select("pergunta,resposta,id")
        .eq("usuario_id", usuarioId)
        .eq("sessao_id", sessionId)
        .order("id", { ascending: false })
        .limit(10);
      if (Array.isArray(h)) {
        hist = [...h]
          .sort((a, b) => a.id - b.id)
          .map((x) => `${x.pergunta}\n${x.resposta}`);
      }
    } catch {}

    return [...hist, ...docs].join("\n");
  } catch (err) {
    console.error("Erro em buscarContextoNoSupabase:", err.message);
    return "";
  }
}

// inicia servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});