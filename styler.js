function dropDisclaimers(text) {
  if (!text) return text;
  const patterns = [
    /como (uma )?ia[, ]?/gi,
    /não posso fornecer aconselhamento (médico|legal)/gi,
    /isto é apenas para fins educacionais/gi,
    /sou apenas um modelo de linguagem/gi
  ];
  let t = text;
  for (const r of patterns) t = t.replace(r, "");
  return t;
}

function trimFluff(text) {
  if (!text) return text;
  // Remove muletas comuns
  return text
    .replace(/\b(basicamente|de certa forma|na verdade|de alguma maneira|talvez|possivelmente)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function limitSentences(text, max = 6) {
  const parts = (text || "").split(/(?<=[\.\!\?])\s+/).filter(Boolean);
  if (parts.length <= max) return text;
  return parts.slice(0, max).join(" ");
}

function ensurePortuguese(text) {
  // Placeholder: aqui você poderia plugar verificação/normalização pt-BR.
  return text;
}

function ensureFirstPerson(text) {
  if (!text) return text;
  // Se houver distanciamento excessivo, aproxima para primeira pessoa
  // Mantemos "eu" explícito sem forçar sinteticamente.
  return text.replace(/\bminha posição\b/gi, "eu");
}

function styleImplicatedText(text) {
  let t = text || "";
  t = dropDisclaimers(t);
  t = trimFluff(t);
  t = ensurePortuguese(t);
  t = ensureFirstPerson(t);
  t = limitSentences(t, 6);
  return t;
}

export {
  styleImplicatedText
};