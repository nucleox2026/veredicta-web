const CONFIG =
  window.VEREDICTA_CONFIG || {};

const API = String(
  CONFIG.API_BASE_URL ||
  "https://veredicta-api.onrender.com"
).replace(/\/$/, "");

const DJEN_PROXY = String(
  CONFIG.DJEN_PROXY_URL ||
  "https://veredicta-djen-br.guilherme-moussalem.workers.dev"
).replace(/\/$/, "");

const SELECTED_PROCESS_KEY =
  "veredicta_selected_process_v3";

let authToken =
  sessionStorage.getItem(
    "veredicta_google_token"
  ) || "";

let currentProcessRef = null;
let currentProcess = null;
let lastDirectDjenItems = [];

const $ = (id) =>
  document.getElementById(id);


function authHeaders() {
  if (!authToken) {
    return {};
  }

  return {
    Authorization:
      `Bearer ${authToken}`
  };
}


async function parseJsonResponse(
  response
) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}


function escapeHtml(value) {
  return String(
    value == null
      ? ""
      : value
  )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function normalizeProcessNumber(
  value
) {
  return String(
    value || ""
  ).replace(/\D/g, "");
}


function setupBackNavigation() {
  const link = $("backToPrevious");

  if (!link) {
    return;
  }

  const params = new URLSearchParams(
    window.location.search
  );

  const queryOrigin = String(
    params.get("origem") || ""
  ).toLowerCase();

  const storedOrigin = String(
    sessionStorage.getItem(
      "veredicta_process_origin"
    ) || ""
  ).toLowerCase();

  const origin =
    queryOrigin ||
    storedOrigin;

  if (origin === "historico") {
    link.href = "./historico.html";
    link.textContent =
      "← Voltar para o histórico";
    return;
  }

  link.href = "./index.html";
  link.textContent =
    "← Voltar para a pesquisa";
}


function safeOfficialProcessUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(
      String(value)
    );

    const hostname =
      url.hostname.toLowerCase();

    if (
      url.protocol !== "https:" ||
      !hostname.endsWith(".jus.br")
    ) {
      return "";
    }

    return url.href;
  } catch (_) {
    return "";
  }
}


function processYearFromCnj(numero) {
  const digits = String(
    numero || ""
  ).replace(/\D/g, "");

  if (digits.length !== 20) {
    return null;
  }

  const year = Number(
    digits.slice(9, 13)
  );

  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100
  ) {
    return null;
  }

  return year;
}


function isoToday() {
  const now = new Date();

  const yyyy =
    now.getFullYear();

  const mm =
    String(
      now.getMonth() + 1
    ).padStart(2, "0");

  const dd =
    String(
      now.getDate()
    ).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}


function buildDjenConsultationUrl() {
  if (!currentProcessRef) {
    return "";
  }

  const tribunal =
    String(
      currentProcessRef.tribunal || ""
    ).trim().toUpperCase();

  const numero =
    String(
      currentProcessRef.numero || ""
    ).replace(/\D/g, "");

  if (!tribunal || numero.length !== 20) {
    return "";
  }

  const year =
    processYearFromCnj(numero) ||
    new Date().getFullYear();

  const url = new URL(
    "https://comunica.pje.jus.br/consulta"
  );

  url.searchParams.set(
    "siglaTribunal",
    tribunal
  );

  url.searchParams.set(
    "dataDisponibilizacaoInicio",
    `${year}-01-01`
  );

  url.searchParams.set(
    "dataDisponibilizacaoFim",
    isoToday()
  );

  url.searchParams.set(
    "numeroProcesso",
    numero
  );

  return url.href;
}


function setupOfficialDjenSearchLink() {
  const link =
    $("officialDjenSearchLink");

  const status =
    $("officialProcessLinkStatus");

  if (!link || !status) {
    return;
  }

  const href =
    buildDjenConsultationUrl();

  if (!href) {
    link.hidden = true;
    link.removeAttribute("href");
    status.textContent =
      "Não foi possível montar a consulta oficial.";
    return;
  }

  link.href = href;
  link.hidden = false;

  status.textContent =
    "Consulta oficial disponível no DJEN/CNJ.";
}


function setOfficialDocumentLink(
  href,
  statusText
) {
  const link =
    $("officialDocumentLink");

  const status =
    $("officialProcessLinkStatus");

  if (!link || !status) {
    return;
  }

  const safeHref =
    safeOfficialProcessUrl(href);

  if (safeHref) {
    link.href = safeHref;
    link.hidden = false;

    status.textContent =
      statusText ||
      "Publicação exata localizada pelo DJEN/CNJ.";

    return;
  }

  link.hidden = true;
  link.removeAttribute("href");

  if (statusText) {
    status.textContent =
      statusText;
  }
}


async function loadOfficialProcessLink() {
  setupOfficialDjenSearchLink();

  if (!currentProcessRef) {
    setOfficialDocumentLink(
      "",
      "Processo não identificado."
    );
    return;
  }

  try {
    const url =
      `${API}/api/v1/djen-values/analyses/` +
      `${encodeURIComponent(
        currentProcessRef.tribunal
      )}/` +
      `${encodeURIComponent(
        currentProcessRef.numero
      )}`;

    const response =
      await fetch(
        url,
        {
          headers:
            authHeaders()
        }
      );

    if (response.status === 404) {
      setOfficialDocumentLink(
        "",
        "Consulta DJEN/CNJ disponível. " +
        "O Veredicta ainda não salvou uma publicação exata deste processo."
      );
      return;
    }

    const payload =
      await parseJsonResponse(
        response
      );

    if (!response.ok) {
      throw new Error(
        payload.detail ||
        `Erro HTTP ${response.status}`
      );
    }

    const evidence =
      payload.evidencia_dano_moral ||
      payload.evidencia_dano_material ||
      payload.evidencia_dano_estetico ||
      {};

    const principalDocument =
      payload.documento_principal || {};

    const href =
      safeOfficialProcessUrl(
        principalDocument.link ||
        evidence.link
      );

    if (!href) {
      setOfficialDocumentLink(
        "",
        "Consulta DJEN/CNJ disponível. " +
        "Snapshot salvo, mas sem link de publicação exata."
      );
      return;
    }

    setOfficialDocumentLink(
      href,
      "Consulta DJEN/CNJ + publicação exata disponíveis."
    );

  } catch (error) {
    console.error(
      "Erro ao carregar publicação oficial:",
      error
    );

    setOfficialDocumentLink(
      "",
      "Consulta DJEN/CNJ disponível. " +
      "Não foi possível carregar a publicação exata agora."
    );
  }
}

function getProcessReference() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const tribunal = String(
    params.get("tribunal") || ""
  )
    .trim()
    .toUpperCase();

  const numero =
    normalizeProcessNumber(
      params.get("numero")
    );

  if (!tribunal || !numero) {
    return null;
  }

  return {
    tribunal,
    numero
  };
}



function mergePartyCollections(primary, secondary) {
  const result = { ativo: [], passivo: [], outros: [] };

  ["ativo", "passivo", "outros"].forEach((key) => {
    const seen = new Set();
    [primary, secondary].forEach((source) => {
      const rows = source && Array.isArray(source[key]) ? source[key] : [];
      rows.forEach((row) => {
        const item = typeof row === "string" ? { nome: row } : (row || {});
        const name = String(item.nome || "").replace(/\s+/g, " ").trim();
        if (!name) return;
        const dedupe = name.toUpperCase();
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        result[key].push(item);
      });
    });
  });

  return result;
}


function basicPartiesFromDjenItems(items) {
  const result = { ativo: [], passivo: [], outros: [] };
  const seen = { ativo: new Set(), passivo: new Set() };

  const push = (key, name, extra = {}) => {
    const clean = String(name || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const dedupe = clean.toUpperCase();
    if (seen[key].has(dedupe)) return;
    seen[key].add(dedupe);
    result[key].push({ nome: clean, fonte: "DJEN/CNJ", ...extra });
  };

  const roleGroups = [
    { key: "ativo", labels: "AUTOR(?:A)?|REQUERENTE|EXEQUENTE|IMPETRANTE|RECLAMANTE|DEMANDANTE" },
    { key: "passivo", labels: "R[ÉE]U|R[ÉE]|REQUERID[OA]|EXECUTAD[OA]|RECLAMAD[OA]|IMPETRAD[OA]|DEMANDAD[OA]" }
  ];

  const terminators = [
    "AUTOR(?:A)?", "REQUERENTE", "EXEQUENTE", "IMPETRANTE", "RECLAMANTE",
    "R[ÉE]U", "R[ÉE]", "REQUERID[OA]", "EXECUTAD[OA]", "RECLAMAD[OA]", "IMPETRAD[OA]",
    "VISTOS?", "RELAT[ÓO]RIO", "DECIDO", "SENTEN[ÇC]A", "DECIS[ÃA]O", "DESPACHO",
    "PROCESSO", "ADVOGAD[OA]", "INTIMA[ÇC][ÃA]O", "CERTID[ÃA]O"
  ].join("|");

  (Array.isArray(items) ? items : []).forEach((communication) => {
    if (!communication || typeof communication !== "object") return;

    (Array.isArray(communication.destinatarios) ? communication.destinatarios : [])
      .forEach((recipient) => {
        const pole = String(recipient && recipient.polo || "").trim().toUpperCase();
        const name = recipient && recipient.nome;
        if (["A", "ATIVO", "POLO ATIVO", "AUTOR", "AUTORA", "REQUERENTE"].includes(pole)) {
          push("ativo", name, { papel: pole });
        } else if (["P", "PASSIVO", "POLO PASSIVO", "RÉU", "REU", "REQUERIDO", "RECLAMADO"].includes(pole)) {
          push("passivo", name, { papel: pole });
        }
      });

    const text = String(communication.texto || "").replace(/\s+/g, " ").slice(0, 16000);
    if (!text) return;

    roleGroups.forEach(({ key, labels }) => {
      const pattern = new RegExp(
        `\\b(?:${labels})\\s*:\\s*(.+?)(?=\\s+(?:${terminators})\\b|$)`,
        "giu"
      );
      for (const match of text.matchAll(pattern)) {
        const name = String(match[1] || "")
          .replace(/^[\\-–—:;,.\\s]+|[\\-–—:;,\\s]+$/g, "")
          .replace(/\\s+/g, " ")
          .trim();
        if (name.length >= 2 && name.length <= 300) push(key, name, { papel: "rotulo_textual" });
      }
    });
  });

  return result;
}


async function fetchDjenItemsDirectly() {
  if (!currentProcessRef) return [];

  const numero = normalizeProcessNumber(currentProcessRef.numero);
  if (numero.length !== 20) return [];

  const allItems = [];
  let expectedCount = null;

  for (let page = 1; page <= 5; page += 1) {
    const url = new URL(`${DJEN_PROXY}/comunicacoes`);
    url.searchParams.set("numeroProcesso", numero);
    url.searchParams.set("pagina", String(page));
    url.searchParams.set("itensPorPagina", "50");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.erro || payload.message || `DJEN HTTP ${response.status}`);
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (expectedCount === null) {
      const count = Number(payload.count);
      expectedCount = Number.isFinite(count) ? count : null;
    }

    allItems.push(...items.filter((item) => item && typeof item === "object"));

    if (!items.length || items.length < 50) break;
    if (expectedCount !== null && allItems.length >= expectedCount) break;
  }

  return allItems;
}


async function parseDjenItemsInBackend(items) {
  const url = `${processBaseUrl()}/djen/parse?persist=true`;
  const headers = { ...authHeaders(), "Content-Type": "application/json" };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ items })
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.detail || `Erro HTTP ${response.status}`);
  }
  return payload;
}


function liveDefendantNames() {
  const rows = currentProcess && currentProcess.partes && Array.isArray(currentProcess.partes.passivo)
    ? currentProcess.partes.passivo
    : [];
  return rows.map((row) => String(row && row.nome || "").trim()).filter(Boolean);
}


async function applyDirectDjenFallback() {
  if (!currentProcessRef || !currentProcess) return;

  const existingDjen = currentProcess.djen || {};
  const existingParties = currentProcess.partes || {};
  const hasParties =
    (Array.isArray(existingParties.ativo) && existingParties.ativo.length) ||
    (Array.isArray(existingParties.passivo) && existingParties.passivo.length);
  const hasDjenData = Boolean(
    existingDjen.ok && (
      existingDjen.comunicacoes ||
      existingDjen.valor_da_causa_centavos != null ||
      existingDjen.valor_dano_moral_primeiro_grau_centavos != null ||
      existingDjen.valor_dano_moral_final_centavos != null
    )
  );

  if (hasParties && hasDjenData) return;

  try {
    const items = await fetchDjenItemsDirectly();
    if (!items.length) return;
    lastDirectDjenItems = items;

    let parsed = null;
    try {
      parsed = await parseDjenItemsInBackend(items);
    } catch (parseError) {
      console.warn("Backend não interpretou o DJEN; usando fallback local de partes.", parseError);
    }

    const browserParties = basicPartiesFromDjenItems(items);
    const parsedParties = parsed && parsed.partes ? parsed.partes : browserParties;

    currentProcess.partes = mergePartyCollections(
      currentProcess.partes || {},
      mergePartyCollections(browserParties, parsedParties)
    );

    if (parsed) {
      currentProcess.djen = parsed;
      currentProcess.djen_consulta = {
        ok: true,
        status: parsed.status || "sem_valor_moral"
      };
    } else {
      currentProcess.djen_consulta = {
        ok: true,
        status: items.length ? "sem_valor_moral" : "sem_comunicacoes"
      };
    }

    renderProcess(currentProcess);
  } catch (error) {
    console.error("Fallback direto do DJEN falhou:", error);
  }
}


function processBaseUrl() {
  if (!currentProcessRef) {
    throw new Error(
      "Referência do processo não informada."
    );
  }

  return (
    `${API}/api/v1/processes/lookup/` +
    `${encodeURIComponent(
      currentProcessRef.tribunal
    )}/` +
    `${encodeURIComponent(
      currentProcessRef.numero
    )}`
  );
}


function formatDate(value) {
  if (!value) {
    return "—";
  }

  const text =
    String(value);

  if (/^\d{8,14}$/.test(text)) {
    const year =
      text.slice(0, 4);

    const month =
      text.slice(4, 6);

    const day =
      text.slice(6, 8);

    return (
      `${day}/${month}/${year}`
    );
  }

  if (
    /^\d{4}-\d{2}-\d{2}/
      .test(text)
  ) {
    return (
      `${text.slice(8, 10)}/` +
      `${text.slice(5, 7)}/` +
      `${text.slice(0, 4)}`
    );
  }

  return text;
}


function formatDateTime(value) {
  if (!value) {
    return "Data não informada";
  }

  const text =
    String(value);

  if (/^\d{14}$/.test(text)) {
    const date =
      formatDate(text);

    const hour =
      text.slice(8, 10);

    const minute =
      text.slice(10, 12);

    return (
      `${date} · ${hour}:${minute}`
    );
  }

  if (/^\d{8}$/.test(text)) {
    return formatDate(text);
  }

  const date =
    new Date(text);

  if (
    !Number.isNaN(
      date.getTime()
    )
  ) {
    return date.toLocaleString(
      "pt-BR"
    );
  }

  return text;
}


function formatMoneyFromCents(
  cents
) {
  if (
    cents === null ||
    cents === undefined
  ) {
    return "Não identificado";
  }

  const value =
    Number(cents);

  if (!Number.isFinite(value)) {
    return "Não identificado";
  }

  return (
    value / 100
  ).toLocaleString(
    "pt-BR",
    {
      style: "currency",
      currency: "BRL"
    }
  );
}


function friendlyValue(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "Não identificado";
  }

  const labels = {
    sim: "Sim",
    nao: "Não",
    indeterminado: "Indeterminado",
    procedente: "Procedente",
    improcedente: "Improcedente",
    parcialmente_procedente:
      "Parcialmente procedente",
    extinto: "Extinto",
    acordo: "Acordo",
    fixado: "Fixado em decisão judicial",
    mantido: "Mantido",
    reduzido: "Reduzido em recurso",
    majorado: "Majorado em recurso",
    afastado: "Afastado",
    nao_identificado: "Não identificado"
  };

  const key =
    String(value);

  if (labels[key]) {
    return labels[key];
  }

  return key
    .replace(/_/g, " ");
}


async function checkHealth() {
  try {
    const response =
      await fetch(
        `${API}/health`
      );

    if (!response.ok) {
      throw new Error();
    }

    const payload =
      await parseJsonResponse(
        response
      );

    $("healthStatus")
      .textContent =
      payload.status === "ok"
        ? "online"
        : (
          payload.status ||
          "online"
        );

    $("statusDot")
      .classList
      .add("online");

  } catch (_) {
    $("healthStatus")
      .textContent =
      "offline";

    $("statusDot")
      .classList
      .remove("online");
  }
}


function showError(message) {
  $("errorText")
    .textContent =
    message ||
    "Erro inesperado.";

  $("errorCard")
    .hidden = false;
}


function clearError() {
  $("errorCard")
    .hidden = true;

  $("errorText")
    .textContent = "";
}



function readSelectedProcess() {
  try {
    const raw =
      sessionStorage.getItem(SELECTED_PROCESS_KEY);

    if (!raw) {
      return null;
    }

    const row = JSON.parse(raw);

    if (!row || typeof row !== "object") {
      return null;
    }

    const tribunal = String(row.tribunal || "")
      .trim()
      .toUpperCase();

    const numero = normalizeProcessNumber(
      row.numero_processo
    );

    if (
      !currentProcessRef ||
      tribunal !== currentProcessRef.tribunal ||
      numero !== currentProcessRef.numero
    ) {
      return null;
    }

    return row;
  } catch (_) {
    return null;
  }
}


function renderProcessSnapshot(row) {
  if (!row) {
    return;
  }

  document.title =
    "Processo — Veredicta";

  $("processBadge").textContent =
    `FICHA PROCESSUAL · ${
      row.tribunal || currentProcessRef.tribunal
    }`;

  $("processNumber").textContent =
    row.numero_processo || currentProcessRef.numero;

  const classe =
    row.classe_nome || row.classe || "Processo";

  const orgao =
    row.orgao_julgador_nome ||
    row.orgao_julgador ||
    row.tribunal ||
    "DataJud";

  $("processSubtitle").textContent =
    `${classe} · ${orgao}`;

  $("processTribunal").textContent =
    row.tribunal || currentProcessRef.tribunal;

  $("processGrade").textContent =
    row.grau || "—";

  $("processDate").textContent =
    formatDate(row.data_ajuizamento);

  $("processClass").textContent = classe;
  $("processCourt").textContent = orgao;

  renderSubjects(row.assuntos || []);

  $("movementCount").textContent = "…";
  $("movementCountNote").textContent =
    "Consultando DataJud";
  $("movementMeta").textContent =
    "Carregando os detalhes e o histórico processual.";
}


function renderSubjects(
  subjects
) {
  const safeSubjects =
    Array.isArray(subjects)
      ? subjects
      : [];

  if (!safeSubjects.length) {
    $("subjectsList")
      .innerHTML = `
        <span class="subject-chip muted-chip">
          Nenhum assunto informado
        </span>
      `;

    return;
  }

  $("subjectsList")
    .innerHTML =
    safeSubjects
      .map(
        (subject) => `
          <span class="subject-chip">
            <span>
              ${escapeHtml(
                subject.nome ||
                subject.codigo ||
                "Assunto"
              )}
            </span>

            ${
              subject.codigo
                ? `
                  <small>
                    TPU ${escapeHtml(
                      subject.codigo
                    )}
                  </small>
                `
                : ""
            }
          </span>
        `
      )
      .join("");
}


function renderPartyGroup(
  elementId,
  parties
) {
  const element =
    $(elementId);

  const safeParties =
    Array.isArray(parties)
      ? parties
      : [];

  if (!safeParties.length) {
    element.innerHTML = `
      <span class="party-empty">
        Não identificado nas fontes públicas consultadas
      </span>
    `;

    return;
  }

  element.innerHTML =
    safeParties
      .map(
        (party) => `
          <div class="party-item">
            <strong>
              ${escapeHtml(
                party.nome ||
                "Parte não identificada"
              )}
            </strong>

            ${
              party.documento
                ? `
                  <small>
                    ${escapeHtml(
                      party.documento
                    )}
                  </small>
                `
                : ""
            }

            ${
              party.tipo_pessoa
                ? `
                  <small>
                    ${escapeHtml(
                      party.tipo_pessoa
                    )}
                  </small>
                `
                : ""
            }
          </div>
        `
      )
      .join("");
}


function renderMovementComplements(
  complements
) {
  const safeComplements =
    Array.isArray(complements)
      ? complements
      : [];

  if (!safeComplements.length) {
    return "";
  }

  const items =
    safeComplements
      .map((item) => {
        const text =
          item.descricao ||
          item.nome;

        if (!text) {
          return "";
        }

        return `
          <span class="movement-complement">
            ${escapeHtml(text)}
          </span>
        `;
      })
      .filter(Boolean)
      .join("");

  if (!items) {
    return "";
  }

  return `
    <div class="movement-complements">
      ${items}
    </div>
  `;
}


function renderMovements(
  process
) {
  const movements =
    Array.isArray(
      process.movimentos
    )
      ? process.movimentos
      : [];

  const total =
    Number(
      process.movimentos_total
    );

  const displayed =
    Number(
      process.movimentos_exibidos
    );

  const safeTotal =
    Number.isFinite(total)
      ? total
      : movements.length;

  const safeDisplayed =
    Number.isFinite(displayed)
      ? displayed
      : movements.length;

  $("movementCount")
    .textContent =
    safeTotal.toLocaleString(
      "pt-BR"
    );

  if (
    safeTotal >
    safeDisplayed
  ) {
    $("movementCountNote")
      .textContent =
      `${safeDisplayed} mais recentes exibidos`;

    $("movementMeta")
      .textContent =
      `Exibindo os ${safeDisplayed} movimentos mais recentes de ${safeTotal} informados pelo DataJud.`;

  } else {
    $("movementCountNote")
      .textContent =
      "Histórico disponível";

    $("movementMeta")
      .textContent =
      `${safeDisplayed} movimentação(ões) disponível(is) no DataJud.`;
  }

  if (!movements.length) {
    $("movementsList")
      .innerHTML = `
        <div class="empty-panel">
          Nenhuma movimentação encontrada.
        </div>
      `;

    return;
  }

  $("movementsList")
    .innerHTML =
    movements
      .map(
        (movement) => `
          <article class="timeline-item">
            <div class="timeline-dot"></div>

            <div class="timeline-content">
              <span class="timeline-date">
                ${escapeHtml(
                  formatDateTime(
                    movement.data_hora ||
                    movement.dataHora
                  )
                )}
              </span>

              <strong>
                ${escapeHtml(
                  movement.nome ||
                  "Movimentação"
                )}
              </strong>

              <div class="movement-meta-row">
                ${
                  movement.codigo
                    ? `
                      <small>
                        Código ${escapeHtml(
                          movement.codigo
                        )}
                      </small>
                    `
                    : ""
                }

                ${
                  movement.orgao_julgador
                    ? `
                      <small>
                        ${escapeHtml(
                          movement.orgao_julgador
                        )}
                      </small>
                    `
                    : ""
                }
              </div>

              ${renderMovementComplements(
                movement.complementos
              )}
            </div>
          </article>
        `
      )
      .join("");
}


function renderProcess(
  process
) {
  currentProcess =
    process;

  document.title =
    "Processo — Veredicta";

  $("processBadge")
    .textContent =
    `FICHA PROCESSUAL · ${
      process.tribunal || ""
    }`;

  $("processNumber")
    .textContent =
    process.numero_processo ||
    currentProcessRef.numero;

  const classe =
    process.classe_nome ||
    process.classe ||
    "Processo";

  const orgao =
    process.orgao_julgador_nome ||
    process.orgao_julgador ||
    process.tribunal ||
    "DataJud";

  $("processSubtitle")
    .textContent =
    `${classe} · ${orgao}`;

  $("processTribunal")
    .textContent =
    process.tribunal ||
    currentProcessRef.tribunal ||
    "—";

  $("processGrade")
    .textContent =
    process.grau || "—";

  $("processDate")
    .textContent =
    formatDate(
      process.data_ajuizamento
    );

  $("processClass")
    .textContent =
    classe;

  $("processCourt")
    .textContent =
    orgao;

  renderSubjects(
    process.assuntos
  );

  const parties =
    process.partes &&
    typeof process.partes === "object"
      ? process.partes
      : {};

  renderPartyGroup(
    "activeParties",
    parties.ativo
  );

  renderPartyGroup(
    "passiveParties",
    parties.passivo
  );

  renderMovements(
    process
  );

  if (process.djen) {
    renderDjenAnalysis(
      process.djen,
      process.djen_consulta
    );
  }

  const activeCount = Array.isArray(parties.ativo) ? parties.ativo.length : 0;
  const passiveCount = Array.isArray(parties.passivo) ? parties.passivo.length : 0;
  const partyNotice = $("partyNotice");
  if (partyNotice) {
    partyNotice.textContent =
      activeCount || passiveCount
        ? "Partes consolidadas a partir do DataJud e das comunicações públicas do DJEN/CNJ."
        : "As fontes públicas consultadas não expuseram os nomes das partes deste processo.";
  }
}


async function loadProcess() {
  if (!currentProcessRef) {
    showError(
      "A URL não contém tribunal e número de processo válidos."
    );

    $("processNumber")
      .textContent =
      "Processo não informado";

    $("processSubtitle")
      .textContent =
      "Volte para a pesquisa e selecione um processo.";

    return false;
  }

  clearError();

  try {
    const response =
      await fetch(
        processBaseUrl(),
        {
          headers:
            authHeaders()
        }
      );

    const payload =
      await parseJsonResponse(
        response
      );

    if (!response.ok) {
      throw new Error(
        payload.detail ||
        `Erro HTTP ${response.status}`
      );
    }

    currentProcess = payload;

    renderProcess(
      currentProcess
    );

    await applyDirectDjenFallback();

    return true;

  } catch (error) {
    showError(
      `Não foi possível carregar os detalhes do processo no DataJud: ${
        error.message || "erro inesperado"
      }. Endpoint consultado: ${processBaseUrl()}`
    );

    $("movementCountNote")
      .textContent =
      "Detalhes indisponíveis";

    $("movementMeta")
      .textContent =
      "Os dados resumidos da pesquisa foram preservados acima.";

    $("movementsList")
      .innerHTML = `
        <div class="empty-panel">
          Tente atualizar a página para consultar
          novamente os detalhes no DataJud.
        </div>
      `;

    return false;
  }
}


function renderList(
  elementId,
  values
) {
  const element =
    $(elementId);

  const safeValues =
    Array.isArray(values)
      ? values
      : [];

  if (!safeValues.length) {
    element.innerHTML = `
      <li>
        Nenhuma informação identificada.
      </li>
    `;

    return;
  }

  element.innerHTML =
    safeValues
      .map(
        (value) => `
          <li>
            ${escapeHtml(value)}
          </li>
        `
      )
      .join("");
}


function exposeDjenDocumentSection() {
  const section = $("djenAnalysisSection");
  const analysisContent = $("analysisContent");

  if (!section || !analysisContent) {
    return;
  }

  const analysisCard = analysisContent.closest(".card");
  if (analysisCard && analysisCard.parentNode && section.parentNode !== analysisCard.parentNode) {
    section.classList.add("card");
    analysisCard.parentNode.insertBefore(section, analysisCard);
  }

  const grid = section.querySelector(".djen-analysis-grid");
  if (grid && !$("djenCauseValue")) {
    const article = document.createElement("article");
    article.className = "analysis-item";
    article.innerHTML = `
      <span>Valor da causa · menção documental</span>
      <strong id="djenCauseValue">—</strong>
    `;
    grid.appendChild(article);
  }
}


function renderDjenAnalysis(djen, consulta) {
  const data = djen || {};
  const status = String(
    data.status ||
    (consulta && consulta.status) ||
    "nao_consultado"
  );

  $("djenMoralFirst").textContent =
    data.valor_dano_moral_primeiro_grau_centavos != null
      ? formatMoneyFromCents(data.valor_dano_moral_primeiro_grau_centavos)
      : "—";

  $("djenMoralFinal").textContent =
    data.valor_dano_moral_final_centavos != null
      ? formatMoneyFromCents(data.valor_dano_moral_final_centavos)
      : "—";

  $("djenEstheticFirst").textContent =
    data.valor_dano_estetico_primeiro_grau_centavos != null
      ? formatMoneyFromCents(data.valor_dano_estetico_primeiro_grau_centavos)
      : "—";

  $("djenMaterialFirst").textContent =
    data.valor_dano_material_primeiro_grau_centavos != null
      ? formatMoneyFromCents(data.valor_dano_material_primeiro_grau_centavos)
      : "—";

  if ($("djenCauseValue")) {
    $("djenCauseValue").textContent =
      data.valor_da_causa_centavos != null
        ? formatMoneyFromCents(data.valor_da_causa_centavos)
        : "—";
  }

  const statusLabels = {
    valor_moral_encontrado: "Valor moral localizado",
    sem_valor_moral: "Sem valor moral localizado",
    sem_comunicacoes: "Sem publicação localizada",
    rate_limit: "DJEN temporariamente limitado",
    indisponivel_temporariamente: "DJEN indisponível agora",
    erro_persistencia: "Falha ao salvar consulta",
    nao_consultado: "Ainda não consultado"
  };

  $("djenAnalysisStatus").textContent =
    statusLabels[status] || friendlyValue(status);

  const principalDocument =
    data.documento_principal || null;

  const documentBox =
    $("djenDocumentBox");

  const documentLink =
    $("djenDocumentLink");

  if (principalDocument) {
    documentBox.hidden = false;

    $("djenDocumentType").textContent =
      principalDocument.tipo_documento ||
      "Documento judicial";

    $("djenDocumentDate").textContent =
      principalDocument.data
        ? `Disponibilização: ${formatDate(principalDocument.data)}`
        : "Data não informada";

    $("djenDocumentResult").textContent =
      principalDocument.resultado_documental ||
      "Resultado não classificado";

    $("djenDocumentExcerpt").textContent =
      principalDocument.trecho_dispositivo ||
      "Trecho decisório não identificado.";

    const documentUrl =
      safeOfficialProcessUrl(
        principalDocument.link
      );

    if (documentUrl) {
      documentLink.href =
        documentUrl;

      documentLink.hidden =
        false;

      setOfficialDocumentLink(
        documentUrl,
        "Consulta DJEN/CNJ + teor oficial disponíveis."
      );
    } else {
      documentLink.hidden =
        true;

      documentLink.removeAttribute(
        "href"
      );
    }
  } else {
    documentBox.hidden =
      true;

    documentLink.hidden =
      true;

    documentLink.removeAttribute(
      "href"
    );
  }

  const evidence =
    data.evidencia_dano_moral ||
    data.evidencia_dano_material ||
    data.evidencia_dano_estetico ||
    null;

  const evidenceBox = $("djenEvidenceBox");
  const evidenceLink = $("djenEvidenceLink");

  if (evidence && evidence.trecho) {
    evidenceBox.hidden = false;
    $("djenEvidenceText").textContent = evidence.trecho;

    const meta = [];
    if (evidence.tipo_documento) meta.push(evidence.tipo_documento);
    if (evidence.data) meta.push(evidence.data);
    if (evidence.secao) meta.push(`Seção: ${evidence.secao}`);
    if (evidence.confianca) meta.push(`Confiança: ${evidence.confianca}`);
    $("djenEvidenceMeta").textContent = meta.join(" · ");

    const officialUrl = safeOfficialProcessUrl(evidence.link);
    if (officialUrl) {
      evidenceLink.href = officialUrl;
      evidenceLink.hidden = false;
      setOfficialDocumentLink(
        officialUrl,
        "Publicação oficial localizada pelo DJEN/CNJ."
      );
    } else {
      evidenceLink.hidden = true;
      evidenceLink.removeAttribute("href");
    }
  } else {
    evidenceBox.hidden = true;
    evidenceLink.hidden = true;
    evidenceLink.removeAttribute("href");
  }

  const checked = data.checked_at
    ? `Última consulta: ${formatDateTime(data.checked_at)}.`
    : "";

  let notice = checked;

  if (status === "sem_valor_moral") {
    notice =
      principalDocument
        ? (
          "Publicação decisória localizada. Nenhum valor de dano moral " +
          "com evidência forte foi localizado no dispositivo. " + checked
        )
        : (
          "Foram encontradas publicações, mas nenhum valor de dano moral " +
          "com evidência forte no dispositivo. " + checked
        );
  } else if (status === "sem_comunicacoes") {
    notice =
      "O DJEN/CNJ não retornou publicação pública para este processo. " + checked;
  } else if (status === "rate_limit") {
    notice =
      "A análise jurídica foi salva, mas o DJEN atingiu o limite temporário. " +
      "Uma nova análise manual pode tentar novamente depois.";
  } else if (status === "indisponivel_temporariamente") {
    notice =
      "A análise jurídica foi salva, mas a consulta ao DJEN não pôde ser " +
      "concluída agora.";
  } else if (status === "valor_moral_encontrado") {
    notice =
      "Valor documental extraído deterministicamente do dispositivo. " + checked;
  }

  $("djenAnalysisNotice").textContent =
    notice ||
    "A consulta documental é feita quando você solicita a análise.";
}


function showAnalysisEmpty() {
  $("analysisEmpty")
    .hidden = false;

  $("analysisLoading")
    .hidden = true;

  $("analysisContent")
    .hidden = true;

  $("analysisStatus")
    .textContent =
    "Não analisado";

  if (!(currentProcess && currentProcess.djen)) {
    renderDjenAnalysis(
      null,
      { status: "nao_consultado" }
    );
  }
}


function renderAnalysis(
  analysis
) {
  $("analysisEmpty")
    .hidden = true;

  $("analysisLoading")
    .hidden = true;

  $("analysisContent")
    .hidden = false;

  $("analysisStatus")
    .textContent =
    "Analisado";

  const liveDjen =
    currentProcess && currentProcess.djen
      ? currentProcess.djen
      : analysis.djen;

  const liveDjenConsulta =
    currentProcess && currentProcess.djen_consulta
      ? currentProcess.djen_consulta
      : analysis.djen_consulta;

  renderDjenAnalysis(
    liveDjen,
    liveDjenConsulta
  );

  $("analysisMoral")
    .textContent =
    friendlyValue(
      analysis.dano_moral
    );

  $("analysisPersonality")
    .textContent =
    friendlyValue(
      analysis
        .direito_personalidade
    );

  const liveDefendants = liveDefendantNames();
  const analysisCompanyValue = String(analysis.empresa_re || "").trim();
  const companyMissing =
    !analysisCompanyValue ||
    ["nao_identificado", "não identificado", "nao identificado"].includes(analysisCompanyValue.toLowerCase());

  $("analysisCompany")
    .textContent =
    companyMissing && liveDefendants.length
      ? liveDefendants.join(" · ")
      : friendlyValue(analysis.empresa_re);

  $("analysisResult")
    .textContent =
    friendlyValue(
      analysis.resultado
    );

  $("analysisResultConfidence")
    .textContent =
    (
      analysis.confianca_resultado !== null &&
      analysis.confianca_resultado !== undefined
    )
      ? `${analysis.confianca_resultado}%`
      : "Não calculada";

  const firstInstanceValue =
    analysis
      .valor_primeiro_grau_centavos;

  const finalValue =
    analysis
      .valor_final_centavos;

  const isNewJurimetricAnalysis =
    Boolean(
      analysis.prompt_version
    );

  $("analysisFirstInstanceValue")
    .textContent =
    (
      firstInstanceValue !== null &&
      firstInstanceValue !== undefined
    )
      ? formatMoneyFromCents(
          firstInstanceValue
        )
      : (
        isNewJurimetricAnalysis
          ? "Não identificado"
          : "Reanálise necessária"
      );

  $("analysisFinalValue")
    .textContent =
    (
      finalValue !== null &&
      finalValue !== undefined
    )
      ? formatMoneyFromCents(
          finalValue
        )
      : (
        isNewJurimetricAnalysis
          ? "Não identificado"
          : "Reanálise necessária"
      );

  $("analysisValueStatus")
    .textContent =
    isNewJurimetricAnalysis
      ? friendlyValue(
          analysis.situacao_valor ||
          "nao_identificado"
        )
      : "Reanálise necessária";

  const officialDocumentValue =
    analysis.valor_origem === "djen_documental";

  $("analysisValueConfidence")
    .textContent =
    officialDocumentValue
      ? `${friendlyValue(
          analysis.valor_confianca_documental || "alta"
        )} (documental)`
      : (
          analysis.confianca_valor !== null &&
          analysis.confianca_valor !== undefined
        )
          ? `${analysis.confianca_valor}%`
          : "Não calculada";

  $("analysisValueSource")
    .textContent =
    (
      analysis.fonte_valor ||
      (
        isNewJurimetricAnalysis
          ? "Não identificada"
          : "Reanálise necessária"
      )
    );

  $("analysisConfidence")
    .textContent =
    (
      analysis.confianca !== null &&
      analysis.confianca !== undefined
    )
      ? `${analysis.confianca}%`
      : "—";

  $("analysisSummary")
    .textContent =
    analysis.resumo ||
    "Resumo não disponível.";

  renderList(
    "analysisFoundations",
    analysis.fundamentos
  );

  renderList(
    "analysisLimitations",
    analysis.limitacoes
  );

  const analysisMeta = [];

  if (analysis.model_name) {
    analysisMeta.push(
      `Modelo: ${analysis.model_name}`
    );
  }

  if (analysis.prompt_version) {
    analysisMeta.push(
      `Prompt: ${analysis.prompt_version}`
    );
  }

  if (analysis.analyzed_at) {
    analysisMeta.push(
      `Analisado em: ${formatDateTime(
        analysis.analyzed_at
      )}`
    );
  }

  $("analysisModel")
    .textContent =
    analysisMeta.join(" · ");
}


async function loadExistingAnalysis() {
  if (!currentProcessRef) {
    return;
  }

  $("analysisStatus")
    .textContent =
    "Verificando...";

  try {
    const response =
      await fetch(
        `${processBaseUrl()}/analysis`,
        {
          headers:
            authHeaders()
        }
      );

    if (
      response.status === 404
    ) {
      showAnalysisEmpty();
      return;
    }

    const payload =
      await parseJsonResponse(
        response
      );

    if (!response.ok) {
      throw new Error(
        payload.detail ||
        "Erro ao carregar análise."
      );
    }

    renderAnalysis(
      payload
    );

    await loadOfficialProcessLink();

  } catch (error) {
    console.error(
      "Erro ao carregar análise:",
      error
    );

    showAnalysisEmpty();
  }
}


async function runAnalysis(
  force
) {
  if (
    !currentProcessRef ||
    !currentProcess
  ) {
    showError(
      "Carregue o processo antes de solicitar a análise."
    );

    return;
  }

  clearError();

  $("analysisEmpty")
    .hidden = true;

  $("analysisContent")
    .hidden = true;

  $("analysisLoading")
    .hidden = false;

  $("analysisStatus")
    .textContent =
    "Analisando...";

  $("djenAnalysisStatus").textContent =
    "Consultando após a análise...";

  $("djenAnalysisNotice").textContent =
    "A análise jurídica será salva mesmo se o DJEN estiver temporariamente indisponível.";

  $("analyzeButton")
    .disabled = true;

  $("reanalyzeButton")
    .disabled = true;

  try {
    const url =
      `${processBaseUrl()}/analyze` +
      `?force=${
        force
          ? "true"
          : "false"
      }`;

    const response =
      await fetch(
        url,
        {
          method: "POST",
          headers:
            authHeaders()
        }
      );

    const payload =
      await parseJsonResponse(
        response
      );

    if (!response.ok) {
      throw new Error(
        payload.detail ||
        `Erro HTTP ${response.status}`
      );
    }

    renderAnalysis(
      payload
    );

    // Se o navegador já conseguiu consultar o Worker DJEN antes da análise,
    // reenviamos o mesmo lote agora que a análise existe no banco. Isso
    // persiste a empresa ré mesmo quando o Render não consegue alcançar o
    // Worker diretamente.
    if (lastDirectDjenItems.length) {
      try {
        await parseDjenItemsInBackend(lastDirectDjenItems);
      } catch (syncError) {
        console.warn(
          "Não foi possível persistir o fallback DJEN após a análise.",
          syncError
        );
      }
    }

    await loadOfficialProcessLink();

  } catch (error) {
    $("analysisLoading")
      .hidden = true;

    $("analysisStatus")
      .textContent =
      "Erro";

    showAnalysisEmpty();

    showError(
      error.message ||
      "Erro durante a análise."
    );

  } finally {
    $("analyzeButton")
      .disabled = false;

    $("reanalyzeButton")
      .disabled = false;
  }
}


function bindEvents() {
  $("analyzeButton")
    .addEventListener(
      "click",
      () => {
        runAnalysis(false);
      }
    );

  $("reanalyzeButton")
    .addEventListener(
      "click",
      () => {
        const confirmed =
          window.confirm(
            "Deseja executar uma nova análise com IA? Isso fará uma nova chamada ao provedor."
          );

        if (confirmed) {
          runAnalysis(true);
        }
      }
    );
}


async function initializePage() {
  exposeDjenDocumentSection();
  bindEvents();
  setupBackNavigation();
  checkHealth();

  currentProcessRef =
    getProcessReference();

  if (currentProcessRef) {
    $("processBadge").textContent =
      `FICHA PROCESSUAL · ${currentProcessRef.tribunal}`;

    $("processNumber").textContent =
      currentProcessRef.numero;

    $("processTribunal").textContent =
      currentProcessRef.tribunal;
  }

  const snapshot =
    readSelectedProcess();

  if (snapshot) {
    renderProcessSnapshot(snapshot);
  }

  const loaded =
    await loadProcess();

  // A análise armazenada pode ser exibida mesmo se
  // a consulta de detalhe ao DataJud falhar.
  await loadExistingAnalysis();
  await loadOfficialProcessLink();

  if (!loaded) {
    $("analyzeButton").disabled = true;

    if ($("analysisContent").hidden) {
      $("analysisStatus").textContent =
        "Detalhe indisponível";

      $("analysisEmpty").hidden = true;
    }
  }
}


document.addEventListener(
  "DOMContentLoaded",
  initializePage
);
