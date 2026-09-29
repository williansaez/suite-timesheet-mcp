// Puro. Primeira validação de uma proposta, para o Claude ter um erro imediato e legível.
// A extensão volta a validar (normalize/match): esta é a rede, aquela é a verdade.

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const erroProposta = (problemas) => Object.assign(
  new Error(`Proposta inválida:\n${problemas.join('\n')}`),
  { code: 'ERR_PROPOSTA', problemas },
);

function dataValida(texto) {
  const m = DATA_ISO.exec(String(texto ?? ''));
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

export const MODOS = ['normal', 'somar', 'sobregravar'];

// modo (extensão 1.1): normal | somar | sobregravar. espelho: true é o nome da 1.0 para sobregravar.
export function validarProposta({ linhas, espelho = false, modo: pedido, nome } = {}, mesVisivel = null) {
  const modo = pedido ?? (espelho === true ? 'sobregravar' : 'normal');
  const problemas = [];
  if (!MODOS.includes(modo)) problemas.push(`modo tem de ser ${MODOS.join(', ')}.`);
  const lista = Array.isArray(linhas) ? linhas : [];
  if (!Array.isArray(linhas)) problemas.push('"linhas" tem de ser um array.');
  else if (linhas.length === 0 && modo !== 'sobregravar') problemas.push('Sem linhas. Para limpar o mês usa modo: "sobregravar".');

  const normalizadas = lista.map((linha, i) => {
    const n = i + 1;
    const temId = linha?.option_id !== undefined && linha.option_id !== null && linha.option_id !== '';
    const temNome = typeof linha?.project === 'string' && linha.project.trim() !== '';
    if (temId === temNome) problemas.push(`linha ${n}: indica exatamente um de option_id ou project.`);
    if (temId && !(Number.isInteger(Number(linha.option_id)) && Number(linha.option_id) > 0)) {
      problemas.push(`linha ${n}: option_id tem de ser um inteiro positivo.`);
    }
    const data = dataValida(linha?.date);
    if (!data) problemas.push(`linha ${n}: date tem de ser YYYY-MM-DD e uma data real.`);
    else if (mesVisivel && (data.ano !== mesVisivel.ano || data.mes !== mesVisivel.mes)) {
      problemas.push(`linha ${n}: ${linha.date} está fora do mês visível ${mesVisivel.ano}-${String(mesVisivel.mes).padStart(2, '0')}.`);
    }
    const horas = Number(linha?.hours);
    // Em somar um negativo subtrai: a extensão valida o resultado (0 a 23,5) contra o Suite.
    const noIntervalo = modo === 'somar'
      ? horas !== 0 && Math.abs(horas) <= 23.5
      : horas > 0 && horas <= 23.5;
    if (!Number.isFinite(horas) || !noIntervalo || Math.round(horas * 2) !== horas * 2) {
      problemas.push(modo === 'somar'
        ? `linha ${n}: hours em somar tem de ser diferente de 0, entre -23,5 e 23,5, em passo de 0,5.`
        : `linha ${n}: hours tem de estar entre 0,5 e 23,5 em passo de 0,5.`);
    }
    // comment (Observações do Suite) é opcional; vazio fica de fora e o Suite mantém o que tem.
    const comentario = linha?.comment;
    if (comentario !== undefined && comentario !== null && typeof comentario !== 'string') {
      problemas.push(`linha ${n}: comment tem de ser texto.`);
    }
    const textoComentario = typeof comentario === 'string' ? comentario.trim() : '';
    // O Suite (validação de pedidos do ASP.NET) responde 200 sem gravar estes padrões.
    if (/<[A-Za-z!/?]|&#/.test(textoComentario)) {
      problemas.push(`linha ${n}: comment não pode ter "<" seguido de letra nem "&#" (o Suite ignora-o sem avisar).`);
    }
    return {
      option_id: temId ? Number(linha.option_id) : '',
      project: temNome ? linha.project.trim() : '',
      date: String(linha?.date ?? ''),
      hours: horas,
      ...(textoComentario ? { comment: textoComentario } : {}),
    };
  });

  if (problemas.length > 0) throw erroProposta(problemas);
  return {
    linhas: normalizadas,
    modo,
    // Enviado também para uma extensão 1.0, que só conhece espelho.
    espelho: modo === 'sobregravar',
    nome: typeof nome === 'string' && nome.trim() ? nome.trim() : 'proposta do Claude',
  };
}
