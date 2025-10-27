// helpers para interacao com gemini com prompt implicada direto

// prompt direto no estilo implicada (condensado)
function buildImplicadaHeader() {
  return `
Manifesto operacional (resumo):
- finalidade: facilitar implicação do sujeito com a própria presença
- posição: nunca protagonista; dobradiça entre partes vivas
- silêncio: parte ativa; pode propor pausa breve quando fizer sentido
- tempo: ritmo lento; respostas curtas
- linguagem: devolução simbólica e viva; sem floreios
- propósito: explicitar gesto implicado; mapear tensões e ambivalências
- coletividade: considerar dimensão ética e histórica sem doutrinar
- simulação: não simular humanidade; declarar limites e fontes
- fontes: priorizar materiais do Dr. Sérgio Spritzer
NÃO REPITA O QUE O USUÁRIO JÁ DISSE.

Instruções:
- fala como eu, natural e consultiva; frases curtas; evita jargões
- checa entendimento com 1 pergunta curta quando necessário
- nomeia 1–2 elementos concretos trazidos; evita generalidades
- se faltar base, reconhece o limite e pede elementos concretos
- sem aspas desnecessárias e sem travessão; não simular emoção
- encerra, quando fizer sentido, com 1 pergunta viva e direta
NÃO REPITA O QUE O USUÁRIO JÁ DISSE.

Escopo:
- neurologia, transtornos da comunicação, inteligência humana, psicanálise, PNL, hipnose, interações humanas
- fora do escopo: reconhecer limite e convidar a recolocar

Adaptação de voz:
- identifica se o endereçamento é você/ele/nós e espelha

Forma:
- devolução curta, direta e simbólica; evita recapitular o óbvio
- evite usar aspas desnecessárias e travessões.
- CONVERSA NATURAL, RESPONDA DIRETO, RECAPITULE SÓ SE NECESSÁRIO.
NÃO REPITA O QUE O USUÁRIO JÁ DISSE, SÓ SE FOR PRECISO PARA ESCLARECER.
SEJA DIRETO, NÃO REPITA O QUE O USUÁRIO JÁ DISSE.
FALE DE MANEIRA NATURAL, UM DIÁLOGO NORMAL E HUMANO.
`.trim();
}

// monta mensagens para o modelo com contexto e historico
function montarMensagens({ historico, contexto, mensagem }) {
  const header = buildImplicadaHeader();

  const msgs = [];
  msgs.push({ role: "user", parts: [{ text: header }] });

  if (contexto && contexto.trim()) {
    msgs.push({
      role: "user",
      parts: [{ text: `Contexto possivelmente relevante (usar indiretamente, reelaborar):\n\n${contexto}` }]
    });
  }

  if (Array.isArray(historico) && historico.length > 0) {
    for (const h of historico) {
      if (h.pergunta) msgs.push({ role: "user", parts: [{ text: h.pergunta }] });
      if (h.resposta) msgs.push({ role: "model", parts: [{ text: h.resposta }] });
    }
  }

  msgs.push({ role: "user", parts: [{ text: String(mensagem || "") }] });
  return msgs;
}

// gera resposta generica com prompt implicada
async function generateByPosition({ gemini, mensagem, contexto, historico /* posicao ignorado */ }) {
  const modelName = process.env.GEMINI_MODEL || "gemini-1.5-pro";
  const model = gemini.getGenerativeModel({ model: modelName });

  const messages = montarMensagens({ historico, contexto, mensagem });

  const result = await model.generateContent({ contents: messages });

  const saida =
    result?.response?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim() ||
    "Eu reconheço que, neste momento, não tenho clareza suficiente para responder plenamente.";

  return saida;
}

// gera perguntas de continuacao curtas e consultivas
async function gerarPerguntasContinuacao({ gemini, baseText, mensagem /* posicao ignorado */ }) {
  const followModelName =
    process.env.GEMINI_FOLLOWUPS_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const followModel = gemini.getGenerativeModel({ model: followModelName });

  const prompt = `
Gere de 1 a 2 perguntas de continuação, curtas (máx. 140 caracteres), abertas e consultivas, em português (Brasil).
Espelhe o modo de endereçamento do usuário (você/ele/nós) e nomeie 1 elemento concreto trazido.
Evite perguntas genéricas ou retóricas. Uma por linha, sem numeração.

Mensagem do usuário:
${(mensagem || "").trim()}

Resposta fornecida:
${(baseText || "").trim()}
`.trim();

  const result = await followModel.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });

  const raw =
    result?.response?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || "")
      .filter(Boolean)
      .join("\n") || "";

  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[\-\d\.\)\s]+/, "").trim())
    .filter((l) => l.length > 0);

  const uniq = Array.from(new Set(lines)).slice(0, 2).map((q) => q.slice(0, 140));
  return uniq;
}

export { generateByPosition, gerarPerguntasContinuacao };