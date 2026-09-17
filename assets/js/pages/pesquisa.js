const CONFIG = window.VEREDICTA_CONFIG || {};

const API = String(
  CONFIG.API_BASE_URL || "https://veredicta-api.onrender.com"
).replace(/\/$/, "");

const DJEN_PROXY = String(
  CONFIG.DJEN_PROXY_URL ||
  "https://veredicta-djen-br.guilherme-moussalem.workers.dev"
).replace(/\/$/, "");

const SEARCH_STATE_KEY =
  "veredicta_search_state_v8_subject_text";

const LEGACY_SEARCH_STATE_KEY =
  "veredicta_search_state_v7_company_text_fallback";

const SELECTED_PROCESS_KEY =
  "veredicta_selected_process_v3";

let authToken =
  sessionStorage.getItem("veredicta_google_token") || "";

let tribunalCatalog = [];
let selectedTribunals = new Set();
let loadedRows = [];
let nextSearchAfterByTribunal = {};
let lastSearchRequest = null;
let searchSummary = [];
let totalFound = 0;
let errorCount = 0;
let searchInProgress = false;
let companyEnrichmentInProgress = false;
let companyRetryTimer = null;

let fullRankingRows = [];
let fullRankingInProgress = false;
let fullRankingDataLoaded = false;
let fullRankingPaginationComplete = false;
let fullRankingUniqueTotal = 0;
let fullRankingRawTotalFound = 0;
let fullRankingStatusText = "";
let fullRankingErrorText = "";
let savedRankingUpdatedAt = "";
let companyModalRows = [];

const $ = (id) => document.getElementById(id);


function authHeaders() {
  if (!authToken) {
    return {};
  }

  return {
    Authorization: `Bearer ${authToken}`
  };
}


async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}


async function checkHealth() {
  try {
    const response = await fetch(`${API}/health`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await parseJsonResponse(response);

    $("healthStatus").textContent =
      data.status === "ok"
        ? "online"
        : (data.status || "online");

    $("statusDot").classList.add("online");
  } catch (_) {
    $("healthStatus").textContent = "offline";
    $("statusDot").classList.remove("online");
  }
}


function initGoogleIdentity() {
  const clientId = CONFIG.GOOGLE_CLIENT_ID;

  if (!clientId) {
    $("authStatus").textContent = "Modo local";
    return;
  }

  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;

  script.onload = () => {
    if (!window.google || !window.google.accounts) {
      $("authStatus").textContent = "Google indisponível";
      return;
    }

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        authToken = response.credential || "";

        if (authToken) {
          sessionStorage.setItem(
            "veredicta_google_token",
            authToken
          );
        }

        $("authStatus").textContent =
          "Autenticado com Google";
      }
    });

    window.google.accounts.id.renderButton(
      $("googleButton"),
      {
        theme: "outline",
        size: "medium",
        text: "signin_with"
      }
    );
  };

  script.onerror = () => {
    $("authStatus").textContent = "Google indisponível";
  };

  document.head.appendChild(script);
}


function showError(message) {
  $("errorText").textContent = message || "Erro inesperado.";
  $("errorCard").hidden = false;
}


function clearError() {
  $("errorCard").hidden = true;
  $("errorText").textContent = "";
}


function showPartialErrors(errors) {
  const safeErrors = Array.isArray(errors) ? errors : [];

  if (!safeErrors.length) {
    $("partialErrorCard").hidden = true;
    $("partialErrorText").innerHTML = "";
    return;
  }

  $("partialErrorCard").hidden = false;
  $("partialErrorText").innerHTML = safeErrors
    .map((item) => {
      return `
        <p>
          <strong>${escapeHtml(item.tribunal || "Tribunal")}:</strong>
          ${escapeHtml(item.error || "Falha na consulta.")}
        </p>
      `;
    })
    .join("");
}


function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function subjectsText(assuntos) {
  const list = Array.isArray(assuntos) ? assuntos : [];

  return list
    .map((item) => {
      if (item && typeof item === "object") {
        return item.nome || item.codigo || "";
      }

      return item || "";
    })
    .filter(Boolean)
    .join("; ");
}


function formatDate(value) {
  if (!value) {
    return "—";
  }

  const text = String(value);

  // DataJud: YYYYMMDDHHMMSS
  if (/^\d{8,14}$/.test(text)) {
    const year = text.slice(0, 4);
    const month = text.slice(4, 6);
    const day = text.slice(6, 8);
    return `${day}/${month}/${year}`;
  }

  // ISO: YYYY-MM-DD...
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)}`;
  }

  return text;
}


function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return number.toLocaleString("pt-BR");
}


function setDefaultDates() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  $("dateFrom").value = `${year}-01-01`;
  $("dateTo").value = `${year}-${month}-${day}`;
}



function saveSearchState() {
  const state = {
    selectedTribunals: Array.from(selectedTribunals),
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    subjectQuery: $("subjectQuery").value,
    pageSizePerTribunal: $("pageSizePerTribunal").value,
    loadedRows: loadedRows,
    nextSearchAfterByTribunal: nextSearchAfterByTribunal,
    lastSearchRequest: lastSearchRequest,
    searchSummary: searchSummary,
    totalFound: totalFound,
    errorCount: errorCount
  };

  try {
    sessionStorage.setItem(
      SEARCH_STATE_KEY,
      JSON.stringify(state)
    );
  } catch (error) {
    console.warn(
      "Não foi possível salvar a pesquisa:",
      error
    );
  }
}


function readSearchState() {
  try {
    const raw =
      sessionStorage.getItem(SEARCH_STATE_KEY) ||
      sessionStorage.getItem(LEGACY_SEARCH_STATE_KEY);

    if (!raw) {
      return null;
    }

    const state = JSON.parse(raw);

    if (!state || typeof state !== "object") {
      return null;
    }

    return state;
  } catch (error) {
    console.warn(
      "Estado de pesquisa inválido:",
      error
    );
    return null;
  }
}


function restoreSearchState() {
  const state = readSearchState();

  if (!state) {
    return false;
  }

  const available = new Set(
    tribunalCatalog.map((item) => item.sigla)
  );

  selectedTribunals = new Set(
    (Array.isArray(state.selectedTribunals)
      ? state.selectedTribunals
      : []
    ).filter((sigla) => available.has(sigla))
  );

  if (!selectedTribunals.size && available.has("TJMT")) {
    selectedTribunals.add("TJMT");
  }

  if (state.dateFrom) {
    $("dateFrom").value = state.dateFrom;
  }

  if (state.dateTo) {
    $("dateTo").value = state.dateTo;
  }

  if (typeof state.subjectQuery === "string") {
    $("subjectQuery").value = state.subjectQuery;
  } else if (state.subjectCode != null) {
    // Migração transparente do estado salvo pela versão anterior.
    $("subjectQuery").value =
      Number(state.subjectCode) === 0
        ? "Danos morais"
        : String(state.subjectCode);
  }

  if (state.pageSizePerTribunal) {
    $("pageSizePerTribunal").value =
      String(state.pageSizePerTribunal);
  }

  loadedRows = Array.isArray(state.loadedRows)
    ? state.loadedRows
    : [];

  nextSearchAfterByTribunal =
    state.nextSearchAfterByTribunal &&
    typeof state.nextSearchAfterByTribunal === "object"
      ? state.nextSearchAfterByTribunal
      : {};

  lastSearchRequest =
    state.lastSearchRequest &&
    typeof state.lastSearchRequest === "object"
      ? state.lastSearchRequest
      : null;

  searchSummary = Array.isArray(state.searchSummary)
    ? state.searchSummary
    : [];

  totalFound = Number(state.totalFound || 0);
  errorCount = Number(state.errorCount || 0);

  return true;
}


function saveSelectedProcess(row) {
  if (!row) {
    return;
  }

  try {
    sessionStorage.setItem(
      SELECTED_PROCESS_KEY,
      JSON.stringify(row)
    );
  } catch (error) {
    console.warn(
      "Não foi possível salvar o processo selecionado:",
      error
    );
  }
}


function handleProcessLinkClick(event) {
  const link = event.target.closest(".process-link");

  if (!link) {
    return;
  }

  const index = Number(link.dataset.rowIndex);

  if (Number.isInteger(index) && loadedRows[index]) {
    saveSelectedProcess(loadedRows[index]);
  }

  saveSearchState();
}


async function loadTribunals() {
  try {
    const response = await fetch(
      `${API}/api/v1/searches/tribunals`,
      {
        headers: authHeaders()
      }
    );

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(
        payload.detail || `Erro HTTP ${response.status}`
      );
    }

    tribunalCatalog = Array.isArray(payload.items)
      ? payload.items
      : [];

    if (!tribunalCatalog.length) {
      throw new Error(
        "Nenhum tribunal foi retornado pela API."
      );
    }

    const restored = restoreSearchState();

    if (!restored) {
      selectedTribunals.clear();

      if (
        tribunalCatalog.some((item) => item.sigla === "TJMT")
      ) {
        selectedTribunals.add("TJMT");
      }
    }

    renderTribunals();

    if (
      restored &&
      (lastSearchRequest || loadedRows.length)
    ) {
      renderSearchResults();
      scheduleCompanyEnrichment(0);
    }
  } catch (error) {
    $("tribunalSelectionInfo").textContent =
      "Não foi possível carregar os tribunais.";

    showError(
      error.message || "Falha ao carregar tribunais."
    );
  }
}


function renderTribunals() {
  const container = $("tribunalList");

  container.innerHTML = tribunalCatalog
    .map((tribunal) => {
      const sigla = tribunal.sigla || "";
      const checked = selectedTribunals.has(sigla)
        ? "checked"
        : "";

      const ufText = tribunal.uf ? ` · ${tribunal.uf}` : "";

      return `
        <label class="tribunal-option">
          <input
            type="checkbox"
            class="tribunal-checkbox"
            value="${escapeHtml(sigla)}"
            ${checked}
          />
          <span>
            <strong>${escapeHtml(sigla + ufText)}</strong>
            <small>${escapeHtml(tribunal.nome || "")}</small>
          </span>
        </label>
      `;
    })
    .join("");

  container
    .querySelectorAll(".tribunal-checkbox")
    .forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedTribunals.add(checkbox.value);
        } else {
          selectedTribunals.delete(checkbox.value);
        }

        updateTribunalSelectionInfo();
        saveSearchState();
      });
    });

  updateTribunalSelectionInfo();
}


function updateTribunalSelectionInfo() {
  $("tribunalSelectionInfo").textContent =
    `${selectedTribunals.size} de ${tribunalCatalog.length} selecionados`;
}


function selectAllTribunals() {
  selectedTribunals = new Set(
    tribunalCatalog.map((item) => item.sigla)
  );

  renderTribunals();
  saveSearchState();
}


function clearTribunalSelection() {
  selectedTribunals.clear();
  renderTribunals();
  saveSearchState();
}


function validateSearch() {
  if (!selectedTribunals.size) {
    throw new Error("Selecione pelo menos um tribunal.");
  }

  const dateFrom = $("dateFrom").value;
  const dateTo = $("dateTo").value;

  if (!dateFrom || !dateTo) {
    throw new Error(
      "Informe a data inicial e a data final."
    );
  }

  if (dateFrom > dateTo) {
    throw new Error(
      "A data inicial não pode ser posterior à data final."
    );
  }
}


function buildInitialSearchRequest() {
  validateSearch();

  const subjectQuery = $("subjectQuery").value.trim();

  return {
    tribunais: Array.from(selectedTribunals),
    date_from: $("dateFrom").value,
    date_to: $("dateTo").value,
    subject_code: null,
    subject_query: subjectQuery || null,
    health_plans_only: true,
    page_size_per_tribunal: Number(
      $("pageSizePerTribunal").value
    ),
    search_after_by_tribunal: null
  };
}


function buildLoadMoreRequest() {
  if (!lastSearchRequest) {
    throw new Error(
      "Faça uma pesquisa antes de carregar mais resultados."
    );
  }

  const activeTribunals = Object.keys(
    nextSearchAfterByTribunal
  );

  if (!activeTribunals.length) {
    throw new Error(
      "Não há mais resultados disponíveis."
    );
  }

  const cursorMap = {};

  activeTribunals.forEach((tribunal) => {
    cursorMap[tribunal] =
      nextSearchAfterByTribunal[tribunal];
  });

  return {
    tribunais: activeTribunals,
    date_from: lastSearchRequest.date_from,
    date_to: lastSearchRequest.date_to,
    subject_code:
      lastSearchRequest.subject_code == null
        ? null
        : lastSearchRequest.subject_code,
    subject_query:
      lastSearchRequest.subject_query || null,
    health_plans_only: true,
    page_size_per_tribunal:
      lastSearchRequest.page_size_per_tribunal,
    search_after_by_tribunal: cursorMap
  };
}


function setSearchLoading(loading, append) {
  searchInProgress = loading;

  $("searchButton").disabled = loading;
  $("loadMore").disabled = loading;

  if (loading) {
    if (append) {
      $("loadMore").textContent = "Carregando...";
    } else {
      $("searchButton").textContent = "Pesquisando...";
    }

    return;
  }

  $("searchButton").textContent = "Pesquisar";
  updateLoadMoreButton();
}


function rowKey(row) {
  return `${row.tribunal || ""}:${row.numero_processo || ""}`;
}


function mergeUniqueRows(currentRows, newRows) {
  const map = new Map();

  currentRows.concat(newRows).forEach((row) => {
    const key = rowKey(row);

    if (!map.has(key)) {
      map.set(key, row);
    }
  });

  return Array.from(map.values()).sort((a, b) => {
    return String(b.data_ajuizamento || "").localeCompare(
      String(a.data_ajuizamento || "")
    );
  });
}



function companyStatusIsFinal(row) {
  const status = String(
    row && row.empresa_re_status
      ? row.empresa_re_status
      : ""
  );

  return (
    status === "found" ||
    status === "not_found"
  );
}


function normalizeCompanyRankingKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function buildCompanyRanking(sourceRows = loadedRows) {
  const companies = new Map();
  let identifiedProcesses = 0;
  let pendingProcesses = 0;

  sourceRows.forEach((row) => {
    const names = Array.isArray(row.empresa_re)
      ? row.empresa_re.filter(Boolean)
      : (row.empresa_re ? [row.empresa_re] : []);

    if (!companyStatusIsFinal(row)) {
      pendingProcesses += 1;
    }

    if (!names.length) {
      return;
    }

    identifiedProcesses += 1;
    const seenInProcess = new Set();

    names.forEach((rawName) => {
      const displayName = String(rawName || "")
        .replace(/\s+/g, " ")
        .trim();

      const key = normalizeCompanyRankingKey(displayName);

      if (!key || seenInProcess.has(key)) {
        return;
      }

      seenInProcess.add(key);

      if (!companies.has(key)) {
        companies.set(key, {
          key,
          count: 0,
          variants: new Map(),
          processes: []
        });
      }

      const entry = companies.get(key);
      entry.count += 1;
      entry.processes.push(row);
      entry.variants.set(
        displayName,
        (entry.variants.get(displayName) || 0) + 1
      );
    });
  });

  const ranking = Array.from(companies.values())
    .map((entry) => {
      const displayName = Array.from(entry.variants.entries())
        .sort((a, b) => {
          if (b[1] !== a[1]) {
            return b[1] - a[1];
          }

          return a[0].localeCompare(b[0], "pt-BR");
        })[0][0];

      return {
        key: entry.key,
        name: displayName,
        count: entry.count,
        processes: entry.processes
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      return a.name.localeCompare(b.name, "pt-BR");
    })
    .slice(0, 5);

  return {
    ranking,
    identifiedProcesses,
    pendingProcesses
  };
}


function rankingExpectedProcessCount(sourceRows = []) {
  if (fullRankingPaginationComplete) {
    return Number(fullRankingUniqueTotal || sourceRows.length || 0);
  }

  return Number(totalFound || sourceRows.length || 0);
}


function rankingRawVsUniqueText(sourceRows = []) {
  if (!fullRankingPaginationComplete) {
    return "";
  }

  const raw = Number(fullRankingRawTotalFound || totalFound || 0);
  const unique = Number(fullRankingUniqueTotal || sourceRows.length || 0);

  if (!raw || !unique || raw === unique) {
    return "";
  }

  return ` O DataJud informou ${formatNumber(raw)} registro(s) bruto(s), ` +
    `correspondentes a ${formatNumber(unique)} processo(s) CNJ único(s).`;
}


function renderCompanyRanking() {
  const section = $("companyRankingSection");

  if (!section) {
    return;
  }

  const list = $("companyRankingList");
  const note = $("companyRankingNote");
  const coverage = $("companyRankingCoverage");
  const scanButton = $("fullCompanyScanButton");
  const progress = $("fullCompanyScanProgress");

  if (!loadedRows.length && !fullRankingRows.length) {
    section.hidden = true;
    list.innerHTML = "";
    note.textContent = "";
    coverage.textContent = "—";
    scanButton.hidden = true;
    progress.hidden = true;
    progress.textContent = "";
    return;
  }

  section.hidden = false;

  const sourceRows = fullRankingRows.length
    ? fullRankingRows
    : loadedRows;

  const {
    ranking,
    identifiedProcesses,
    pendingProcesses
  } = buildCompanyRanking(sourceRows);

  const processedProcesses = sourceRows.filter(
    (row) => companyStatusIsFinal(row)
  ).length;

  if (fullRankingRows.length) {
    const expectedProcesses = rankingExpectedProcessCount(sourceRows);
    coverage.textContent =
      `${formatNumber(processedProcesses)} de ` +
      `${formatNumber(expectedProcesses)} consultados`;
  } else {
    coverage.textContent =
      `${formatNumber(identifiedProcesses)} de ` +
      `${formatNumber(loadedRows.length)} processos identificados`;
  }

  if (!ranking.length) {
    list.innerHTML = `
      <div class="company-ranking-empty">
        ${pendingProcesses > 0
          ? "Identificando empresas rés no DJEN..."
          : "Nenhuma empresa ré foi identificada nos resultados processados."}
      </div>
    `;
  } else {
    list.innerHTML = ranking
      .map((item, index) => {
        const processLabel = item.count === 1
          ? "processo"
          : "processos";

        return `
          <article class="company-ranking-item">
            <span class="company-ranking-position">${index + 1}º</span>
            <div class="company-ranking-content">
              <strong>${escapeHtml(item.name)}</strong>
              <small>
                ${formatNumber(item.count)} ${processLabel}
              </small>
              <button
                type="button"
                class="company-ranking-processes-button"
                data-company-key="${escapeHtml(item.key)}"
              >
                Ver ${formatNumber(item.count)} ${processLabel}
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  if (fullRankingInProgress) {
    scanButton.hidden = false;
    scanButton.disabled = true;
    scanButton.textContent = "Processando pesquisa completa...";
    progress.hidden = false;
    progress.textContent = fullRankingStatusText ||
      "Preparando a leitura de todos os resultados da pesquisa.";
  } else if (fullRankingDataLoaded) {
    scanButton.hidden = false;
    scanButton.disabled = false;
    scanButton.textContent = pendingProcesses > 0
      ? `Continuar identificação (${formatNumber(pendingProcesses)} pendente(s))`
      : "Atualizar levantamento completo";
    progress.hidden = false;

    const savedAtText = savedRankingUpdatedAt
      ? ` Última gravação: ${formatDateTime(savedRankingUpdatedAt)}.`
      : "";

    progress.textContent = fullRankingErrorText
      ? fullRankingErrorText
      : `Levantamento salvo: ${formatNumber(sourceRows.length)} processo(s) único(s), ` +
        `${formatNumber(processedProcesses)} processado(s) e ` +
        `${formatNumber(identifiedProcesses)} com empresa ré identificada.` +
        rankingRawVsUniqueText(sourceRows) +
        savedAtText;
  } else {
    const needsFullScan = totalFound > loadedRows.length;
    scanButton.hidden = !needsFullScan;
    scanButton.disabled = false;
    scanButton.textContent = needsFullScan
      ? `Processar todos os ${formatNumber(totalFound)} resultados`
      : "Processar todos os resultados";
    progress.hidden = !fullRankingErrorText;
    progress.textContent = fullRankingErrorText || "";
  }

  const pendingText = pendingProcesses > 0
    ? ` ${formatNumber(pendingProcesses)} processo(s) ainda aguardam identificação no DJEN.`
    : "";

  if (fullRankingRows.length) {
    const expectedProcesses = rankingExpectedProcessCount(sourceRows);
    note.textContent =
      `Ranking calculado sobre ${formatNumber(sourceRows.length)} de ` +
      `${formatNumber(expectedProcesses)} processo(s) CNJ único(s) da pesquisa. ` +
      `Cada empresa é contada no máximo uma vez por processo. ` +
      `O levantamento completo fica salvo no banco para reaproveitar as empresas já consultadas.` +
      rankingRawVsUniqueText(sourceRows) +
      pendingText;
  } else {
    note.textContent =
      "Prévia calculada somente sobre os resultados atualmente carregados. " +
      "Use “Processar todos os resultados” para calcular o Top 5 sobre a pesquisa inteira. " +
      "Cada empresa é contada no máximo uma vez por processo." +
      pendingText;
  }
}


function resetFullCompanyRanking() {
  fullRankingRows = [];
  fullRankingInProgress = false;
  fullRankingDataLoaded = false;
  fullRankingPaginationComplete = false;
  fullRankingUniqueTotal = 0;
  fullRankingRawTotalFound = 0;
  fullRankingStatusText = "";
  fullRankingErrorText = "";
  savedRankingUpdatedAt = "";
  companyModalRows = [];
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function formatDateTime(value) {
  if (!value) {
    return "—";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(parsed);
}


function rankingRequestPayload() {
  if (!lastSearchRequest) {
    return null;
  }

  return {
    tribunais: Array.isArray(lastSearchRequest.tribunais)
      ? lastSearchRequest.tribunais
      : Array.from(selectedTribunals),
    date_from: lastSearchRequest.date_from,
    date_to: lastSearchRequest.date_to,
    subject_code: lastSearchRequest.subject_code == null
      ? null
      : lastSearchRequest.subject_code,
    subject_query: lastSearchRequest.subject_query || null,
    health_plans_only: true
  };
}


async function loadSavedCompanyRanking() {
  const request = rankingRequestPayload();
  if (!request) {
    return false;
  }

  try {
    const response = await fetch(
      `${API}/api/v1/searches/rankings/load`,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: JSON.stringify(request)
      }
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok || !payload.found) {
      return false;
    }

    const savedRows = Array.isArray(payload.rows)
      ? payload.rows
      : [];

    if (!savedRows.length) {
      return false;
    }

    fullRankingRows = mergeUniqueRows([], savedRows);

    const savedUniqueTotal = Number(payload.total_found || savedRows.length || 0);
    const savedRawTotal = Number(
      payload.raw_total_found || payload.total_found || savedRows.length || 0
    );
    const currentRawTotal = Number(totalFound || 0);

    fullRankingRawTotalFound = Math.max(savedRawTotal, currentRawTotal);

    // Um snapshot completo continua completo enquanto a nova consulta não
    // indicar que o DataJud passou a ter mais registros brutos que na coleta
    // salva. Se houver novos registros, retomamos a paginação para incorporá-los.
    fullRankingPaginationComplete = Boolean(payload.pagination_complete) &&
      currentRawTotal <= savedRawTotal;

    fullRankingUniqueTotal = fullRankingPaginationComplete
      ? Math.max(savedUniqueTotal, fullRankingRows.length)
      : 0;

    const expectedTotal = fullRankingPaginationComplete
      ? fullRankingUniqueTotal
      : Math.max(currentRawTotal, savedRawTotal, savedUniqueTotal);

    fullRankingDataLoaded = fullRankingPaginationComplete &&
      (expectedTotal <= 0 || fullRankingRows.length >= expectedTotal);

    savedRankingUpdatedAt = payload.updated_at || "";

    if (fullRankingDataLoaded) {
      fullRankingStatusText =
        `Levantamento completo recuperado do banco: ` +
        `${formatNumber(fullRankingRows.length)} processo(s) CNJ único(s).`;
      fullRankingErrorText = "";
    } else {
      fullRankingStatusText =
        `Levantamento parcial recuperado: ${formatNumber(fullRankingRows.length)} processo(s) único(s). ` +
        `Clique para continuar a coleta.`;
      fullRankingErrorText = fullRankingStatusText;
    }

    renderCompanyRanking();
    return true;
  } catch (error) {
    console.warn("Não foi possível recuperar o ranking salvo:", error);
    return false;
  }
}


async function saveFullCompanyRanking() {
  const request = rankingRequestPayload();
  if (!request || !fullRankingRows.length) {
    return false;
  }

  const response = await fetch(
    `${API}/api/v1/searches/rankings/save`,
    {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        authHeaders()
      ),
      body: JSON.stringify(Object.assign({}, request, {
        total_found: totalFound,
        rows: fullRankingRows,
        pagination_complete: fullRankingPaginationComplete
      }))
    }
  );

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      payload.detail || `Falha ao salvar levantamento: HTTP ${response.status}`
    );
  }

  savedRankingUpdatedAt = payload.updated_at || new Date().toISOString();

  if (payload.pagination_complete) {
    fullRankingPaginationComplete = true;
    fullRankingUniqueTotal = Number(payload.total_found || fullRankingRows.length);
    fullRankingRawTotalFound = Number(
      payload.raw_total_found || totalFound || fullRankingRawTotalFound || 0
    );
  }

  return true;
}


async function hydratePersistentCompanyCache(targetRows) {
  const rows = Array.isArray(targetRows) ? targetRows : [];
  const unresolved = rows.filter((row) => !companyStatusIsFinal(row));

  for (let offset = 0; offset < unresolved.length; offset += 500) {
    const chunk = unresolved.slice(offset, offset + 500);

    fullRankingStatusText =
      `Reaproveitando empresas já salvas: ${formatNumber(Math.min(offset + chunk.length, unresolved.length))} ` +
      `de ${formatNumber(unresolved.length)} verificadas no banco...`;
    renderCompanyRanking();

    const response = await fetch(
      `${API}/api/v1/searches/companies/cache`,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: JSON.stringify({
          items: chunk.map((row) => ({
            tribunal: row.tribunal,
            numero_processo: row.numero_processo
          }))
        })
      }
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        payload.detail || `Falha ao consultar cache: HTTP ${response.status}`
      );
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    updateCompanyRowsIn(rows, items);
    updateCompanyRowsIn(loadedRows, items);
  }
}


function updateCompanyRowsIn(targetRows, items) {
  const byKey = new Map();

  (Array.isArray(items) ? items : []).forEach((item) => {
    byKey.set(
      `${item.tribunal || ""}:${item.numero_processo || ""}`,
      item
    );
  });

  targetRows.forEach((row) => {
    const item = byKey.get(rowKey(row));

    if (!item) {
      return;
    }

    const names = Array.isArray(item.empresas_re)
      ? item.empresas_re.filter(Boolean)
      : [];

    row.empresa_re = names;
    row.empresa_re_status = item.status || "not_found";
    row.empresa_re_fonte = item.fonte || "";
    row.empresa_re_link = item.link || "";
  });
}


async function loadAllRowsForCompanyRanking() {
  // Nunca descarta um levantamento já salvo. Se a atualização falhar no meio,
  // os processos previamente conhecidos continuam disponíveis e não são
  // substituídos por uma amostra menor.
  fullRankingRows = mergeUniqueRows(fullRankingRows, loadedRows);
  fullRankingRawTotalFound = Math.max(
    Number(fullRankingRawTotalFound || 0),
    Number(totalFound || 0)
  );

  if (fullRankingPaginationComplete) {
    fullRankingUniqueTotal = Math.max(
      Number(fullRankingUniqueTotal || 0),
      fullRankingRows.length
    );
    fullRankingStatusText =
      `Todos os ${formatNumber(fullRankingUniqueTotal)} processos CNJ únicos já estão salvos. ` +
      `Não é necessário percorrer novamente as páginas do DataJud.`;
    renderCompanyRanking();
    return;
  }

  let cursorMap = Object.assign({}, nextSearchAfterByTribunal);
  const retryCounts = {};
  let pageNumber = 0;

  while (Object.keys(cursorMap).length) {
    const activeTribunals = Object.keys(cursorMap);
    const rowsBefore = fullRankingRows.length;
    pageNumber += 1;

    fullRankingStatusText =
      `Carregando todos os processos no DataJud: ` +
      `${formatNumber(fullRankingRows.length)} processo(s) CNJ único(s) já reunido(s) ` +
      `(${formatNumber(totalFound)} registro(s) bruto(s) informados pelo DataJud)...`;
    renderCompanyRanking();

    const requestBody = {
      tribunais: activeTribunals,
      date_from: lastSearchRequest.date_from,
      date_to: lastSearchRequest.date_to,
      subject_code:
        lastSearchRequest.subject_code == null
          ? null
          : lastSearchRequest.subject_code,
      subject_query: lastSearchRequest.subject_query || null,
      health_plans_only: true,
      page_size_per_tribunal: 50,
      search_after_by_tribunal: cursorMap
    };

    const response = await fetch(
      `${API}/api/v1/searches/multi`,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: JSON.stringify(requestBody)
      }
    );

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(
        payload.detail ||
        `Falha ao carregar todos os resultados: HTTP ${response.status}`
      );
    }

    fullRankingRows = mergeUniqueRows(
      fullRankingRows,
      Array.isArray(payload.items) ? payload.items : []
    );

    const errorItems = Array.isArray(payload.errors)
      ? payload.errors
      : [];
    const errorsByTribunal = new Map(
      errorItems.map((item) => [item.tribunal, item.error || "Falha temporária"])
    );

    const returnedCursors =
      payload.next_search_after_by_tribunal || {};

    const nextCursors = {};
    let retryDelayMs = 120;
    let retrying = false;

    activeTribunals.forEach((tribunal) => {
      if (errorsByTribunal.has(tribunal)) {
        const attempt = Number(retryCounts[tribunal] || 0) + 1;
        retryCounts[tribunal] = attempt;

        if (attempt > 6) {
          throw new Error(
            `O DataJud continuou falhando para ${tribunal} após 6 tentativas. ` +
            `O levantamento parcial foi preservado; tente continuar novamente em alguns instantes.`
          );
        }

        // Mantém exatamente o mesmo cursor para repetir somente a página que
        // falhou, em vez de encerrar silenciosamente o tribunal.
        if (cursorMap[tribunal]) {
          nextCursors[tribunal] = cursorMap[tribunal];
        }

        retrying = true;
        retryDelayMs = Math.max(
          retryDelayMs,
          Math.min(15000, 1000 * Math.pow(2, attempt - 1))
        );
        return;
      }

      retryCounts[tribunal] = 0;

      const returnedCursor = returnedCursors[tribunal];
      if (!returnedCursor) {
        return;
      }

      // Proteção contra cursor repetido. Sem isso uma resposta anômala do
      // DataJud poderia manter a mesma página indefinidamente.
      const previousCursorText = JSON.stringify(cursorMap[tribunal] || null);
      const returnedCursorText = JSON.stringify(returnedCursor);

      if (
        previousCursorText === returnedCursorText &&
        fullRankingRows.length === rowsBefore
      ) {
        throw new Error(
          `O DataJud repetiu o mesmo cursor para ${tribunal}. ` +
          `O progresso já obtido foi preservado; tente continuar em alguns instantes.`
        );
      }

      nextCursors[tribunal] = returnedCursor;
    });

    cursorMap = nextCursors;
    renderCompanyRanking();

    if (retrying) {
      const retriesText = activeTribunals
        .filter((tribunal) => errorsByTribunal.has(tribunal))
        .map((tribunal) => `${tribunal} (${retryCounts[tribunal]}/6)`)
        .join(", ");

      fullRankingStatusText =
        `DataJud temporariamente indisponível em ${retriesText}. ` +
        `Aguardando ${Math.ceil(retryDelayMs / 1000)} segundo(s) e tentando a mesma página novamente...`;
      renderCompanyRanking();
    }

    await sleep(retryDelayMs);
  }

  // Se não há mais cursores e não houve erro, a paginação terminou. O total
  // do DataJud contabiliza documentos/hits; o ranking trabalha com números CNJ
  // únicos, portanto é normal o total bruto ser maior que fullRankingRows.length.
  fullRankingPaginationComplete = true;
  fullRankingUniqueTotal = fullRankingRows.length;
  fullRankingRawTotalFound = Math.max(
    Number(fullRankingRawTotalFound || 0),
    Number(totalFound || 0)
  );

  const duplicates = Math.max(
    0,
    fullRankingRawTotalFound - fullRankingUniqueTotal
  );

  fullRankingStatusText = duplicates > 0
    ? `DataJud concluído: ${formatNumber(fullRankingRawTotalFound)} registro(s) bruto(s) ` +
      `correspondem a ${formatNumber(fullRankingUniqueTotal)} processo(s) CNJ único(s). ` +
      `${formatNumber(duplicates)} ocorrência(s) repetem número(s) de processo já carregado(s). ` +
      `Iniciando DJEN...`
    : `DataJud concluído: ${formatNumber(fullRankingUniqueTotal)} processo(s) CNJ único(s) carregado(s). ` +
      `Iniciando DJEN...`;
  renderCompanyRanking();

  // Persiste imediatamente o universo completo antes de iniciar centenas de
  // consultas DJEN. Assim fechar o navegador não obriga a paginar o DataJud de novo.
  await saveFullCompanyRanking();
}


async function enrichAllCompaniesForRanking() {
  // Impede a fila pequena da tabela de disputar as mesmas consultas.
  if (companyRetryTimer) {
    clearTimeout(companyRetryTimer);
    companyRetryTimer = null;
  }

  while (companyEnrichmentInProgress) {
    await sleep(200);
  }

  // Primeiro consulta o Aiven/SQLite em lote. Somente processos realmente
  // novos seguem para o DJEN.
  await hydratePersistentCompanyCache(fullRankingRows);
  renderRows();
  saveSearchState();

  let consecutiveErrors = 0;
  let lastSavedProcessed = fullRankingRows.filter(
    (row) => companyStatusIsFinal(row)
  ).length;

  while (true) {
    const pending = fullRankingRows.filter((row) => {
      if (companyStatusIsFinal(row)) {
        return false;
      }

      const status = String(row.empresa_re_status || "");
      return !status || status === "pending" || status === "loading" ||
        status === "rate_limited" || status === "error";
    });

    const processed = fullRankingRows.length - pending.length;

    fullRankingStatusText =
      `Consultando empresas rés no DJEN: ${formatNumber(processed)} de ` +
      `${formatNumber(fullRankingRows.length)} processo(s) processados.`;
    renderCompanyRanking();

    if (!pending.length) {
      break;
    }

    // O endpoint do backend aceita até 8 itens; usamos 4 para manter cada
    // chamada curta e respeitar melhor o rate limit do DJEN.
    const batch = pending.slice(0, 4);

    batch.forEach((row) => {
      row.empresa_re_status = "loading";
    });

    renderCompanyRanking();

    try {
      const response = await fetch(
        `${API}/api/v1/searches/companies`,
        {
          method: "POST",
          headers: Object.assign(
            { "Content-Type": "application/json" },
            authHeaders()
          ),
          body: JSON.stringify({
            items: batch.map((row) => ({
              tribunal: row.tribunal,
              numero_processo: row.numero_processo
            }))
          })
        }
      );

      const payload = await parseJsonResponse(response);

      if (!response.ok) {
        throw new Error(
          payload.detail || `DJEN HTTP ${response.status}`
        );
      }

      const items = Array.isArray(payload.items)
        ? payload.items
        : [];

      updateCompanyRowsIn(fullRankingRows, items);
      updateCompanyRowsIn(loadedRows, items);
      consecutiveErrors = 0;

      const retryAfterSeconds = Number(
        payload.retry_after_seconds || 0
      );

      renderRows();
      saveSearchState();

      const processedNow = fullRankingRows.filter(
        (row) => companyStatusIsFinal(row)
      ).length;

      if (
        processedNow - lastSavedProcessed >= 25 ||
        retryAfterSeconds > 0 ||
        processedNow === fullRankingRows.length
      ) {
        try {
          await saveFullCompanyRanking();
          lastSavedProcessed = processedNow;
        } catch (saveError) {
          console.warn("Não foi possível salvar o progresso do ranking:", saveError);
        }
      }

      if (retryAfterSeconds > 0) {
        fullRankingStatusText =
          `O DJEN atingiu o limite temporário. Aguardando ` +
          `${formatNumber(retryAfterSeconds)} segundo(s) para continuar ` +
          `automaticamente...`;
        renderCompanyRanking();
        await sleep(retryAfterSeconds * 1000);
      } else {
        await sleep(350);
      }
    } catch (error) {
      consecutiveErrors += 1;

      batch.forEach((row) => {
        if (row.empresa_re_status === "loading") {
          row.empresa_re_status = consecutiveErrors >= 3
            ? "error"
            : "pending";
        }
      });

      fullRankingStatusText =
        consecutiveErrors >= 3
          ? "Uma parte das consultas ao DJEN falhou; continuando com os demais processos."
          : "Falha temporária ao consultar o DJEN. Tentando novamente em alguns segundos...";
      renderCompanyRanking();

      if (consecutiveErrors < 3) {
        await sleep(3000);
      } else {
        consecutiveErrors = 0;
        await sleep(500);
      }
    }
  }
}


async function processFullCompanyRanking() {
  if (fullRankingInProgress || !lastSearchRequest || !loadedRows.length) {
    return;
  }

  fullRankingInProgress = true;
  fullRankingDataLoaded = false;
  fullRankingErrorText = "";
  fullRankingStatusText = "Preparando a pesquisa completa...";

  // Mantém o snapshot recuperado do Aiven e acrescenta os resultados recém
  // carregados na tela. Nunca recomeça do zero ao atualizar.
  fullRankingRows = mergeUniqueRows(fullRankingRows, loadedRows);
  const rowsBeforeUpdate = fullRankingRows.length;
  renderCompanyRanking();

  try {
    await loadAllRowsForCompanyRanking();
    await enrichAllCompaniesForRanking();
    fullRankingStatusText = "Salvando levantamento no banco...";
    renderCompanyRanking();
    await saveFullCompanyRanking();
    fullRankingDataLoaded = fullRankingPaginationComplete;

    if (!fullRankingDataLoaded) {
      fullRankingErrorText =
        `Levantamento parcial: ${formatNumber(fullRankingRows.length)} processo(s) único(s) carregado(s). ` +
        `Clique novamente para continuar.`;
    } else {
      fullRankingErrorText = "";
    }
  } catch (error) {
    // Se avançamos antes de uma falha temporária, salva esse progresso. O
    // backend faz merge com o snapshot anterior, portanto nunca reduz a base.
    if (fullRankingRows.length > rowsBeforeUpdate) {
      try {
        await saveFullCompanyRanking();
      } catch (saveError) {
        console.warn("Não foi possível salvar o progresso parcial:", saveError);
      }
    }

    fullRankingDataLoaded = fullRankingPaginationComplete;

    fullRankingErrorText =
      error && error.message
        ? error.message
        : "Não foi possível processar a pesquisa completa.";
  } finally {
    fullRankingInProgress = false;
    renderCompanyRanking();
  }
}

function currentRankingRows() {
  return fullRankingRows.length ? fullRankingRows : loadedRows;
}


function processHasCompany(row, companyKey) {
  const names = Array.isArray(row.empresa_re)
    ? row.empresa_re
    : (row.empresa_re ? [row.empresa_re] : []);

  return names.some(
    (name) => normalizeCompanyRankingKey(name) === companyKey
  );
}


function openCompanyProcesses(companyKey) {
  const key = String(companyKey || "").trim();
  if (!key) {
    return;
  }

  companyModalRows = currentRankingRows()
    .filter((row) => processHasCompany(row, key))
    .sort((a, b) => String(b.data_ajuizamento || "").localeCompare(
      String(a.data_ajuizamento || "")
    ));

  const ranking = buildCompanyRanking(currentRankingRows()).ranking;
  const company = ranking.find((item) => item.key === key);
  const name = company ? company.name : key;

  $("companyProcessesTitle").textContent = name;
  $("companyProcessesCount").textContent =
    `${formatNumber(companyModalRows.length)} processo(s) neste levantamento`;

  $("companyProcessesBody").innerHTML = companyModalRows.length
    ? companyModalRows.map((row, index) => {
        const params = new URLSearchParams();
        params.set("tribunal", row.tribunal || "");
        params.set("numero", row.numero_processo || "");
        params.set("origem", "pesquisa");
        const url = `./processo.html?${params.toString()}`;

        return `
          <tr>
            <td class="process-number">${escapeHtml(row.numero_processo || "—")}</td>
            <td>${escapeHtml(row.tribunal || "—")}</td>
            <td>${escapeHtml(formatDate(row.data_ajuizamento))}</td>
            <td>${escapeHtml(row.classe_nome || "—")}</td>
            <td>${escapeHtml(row.orgao_julgador_nome || "—")}</td>
            <td class="process-actions">
              <a
                class="process-view-button company-modal-process-link"
                href="${escapeHtml(url)}"
                data-company-process-index="${index}"
              >Abrir ficha</a>
            </td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="6" class="empty-row">Nenhum processo encontrado.</td></tr>`;

  $("companyProcessesModal").hidden = false;
  document.body.classList.add("modal-open");
}


function closeCompanyProcesses() {
  $("companyProcessesModal").hidden = true;
  document.body.classList.remove("modal-open");
  companyModalRows = [];
}


function handleCompanyRankingClick(event) {
  const button = event.target.closest(".company-ranking-processes-button");
  if (!button) {
    return;
  }
  openCompanyProcesses(button.dataset.companyKey);
}


function handleCompanyModalClick(event) {
  const link = event.target.closest(".company-modal-process-link");
  if (!link) {
    return;
  }

  const index = Number(link.dataset.companyProcessIndex);
  if (Number.isInteger(index) && companyModalRows[index]) {
    saveSelectedProcess(companyModalRows[index]);
  }
  saveSearchState();
}


function companyCellHtml(row) {
  const names = Array.isArray(row.empresa_re)
    ? row.empresa_re.filter(Boolean)
    : (
        row.empresa_re
          ? [row.empresa_re]
          : []
      );

  if (names.length) {
    const source = row.empresa_re_fonte
      ? `<small>${escapeHtml(row.empresa_re_fonte)}</small>`
      : "";

    return `
      <strong>${escapeHtml(names.join(" / "))}</strong>
      ${source}
    `;
  }

  const status = String(
    row.empresa_re_status || ""
  );

  if (
    status === "loading" ||
    status === "pending" ||
    !status
  ) {
    return `
      <span class="muted-text">
        Identificando no DJEN...
      </span>
    `;
  }

  if (status === "rate_limited") {
    return `
      <span class="muted-text">
        Aguardando DJEN...
      </span>
    `;
  }

  if (status === "error") {
    return `
      <span class="muted-text">
        Não disponível
      </span>
    `;
  }

  return "—";
}



function normalizeProcessDigits(value) {
  return String(value || "").replace(/\D/g, "");
}


function looksLikeCompanyName(value) {
  const name = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    return false;
  }

  const upper = ` ${name.toUpperCase()} `;

  const publicPrefixes = [
    "UNIÃO",
    "UNIAO",
    "ESTADO DE ",
    "MUNICÍPIO DE ",
    "MUNICIPIO DE ",
    "PREFEITURA ",
    "SECRETARIA DE ",
    "MINISTÉRIO ",
    "MINISTERIO ",
    "PROCURADORIA ",
    "DEFENSORIA ",
    "TRIBUNAL ",
    "CÂMARA MUNICIPAL",
    "CAMARA MUNICIPAL",
    "ASSEMBLEIA LEGISLATIVA"
  ];

  if (
    publicPrefixes.some((prefix) =>
      name.toUpperCase().startsWith(prefix)
    )
  ) {
    return false;
  }

  // Na listagem da pesquisa, o dado mais confiável é o próprio polo P
  // estruturado pelo DJEN. Não exigimos LTDA/S.A. porque várias operadoras
  // aparecem somente pela marca/razão abreviada. Excluímos apenas órgãos
  // públicos e valores que sejam somente CPF/CNPJ.
  const documentOnly = /^(?:CPF|CNPJ\s*:\s*)?[\d./-]+$/i;

  if (documentOnly.test(name)) {
    return false;
  }

  return true;
}


function extractDefendantCompaniesFromText(rawText) {
  const text = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);

  if (!text) {
    return [];
  }

  // O DJEN nem sempre inclui o réu em `destinatarios`. Em muitos documentos
  // o polo passivo aparece apenas no texto, por exemplo:
  // "Réu: BRADESCO SAUDE S/A DECISÃO ...".
  const terminators = [
    "AUTOR(?:A)?",
    "REQUERENTE",
    "R[ÉE]U",
    "R[ÉE]",
    "REQUERID[OA]",
    "RECLAMAD[OA]",
    "VISTOS?",
    "RELAT[ÓO]RIO",
    "FUNDAMENTO",
    "DECIDO",
    "SENTEN[ÇC]A",
    "DECIS[ÃA]O",
    "DESPACHO",
    "AC[ÓO]RD[ÃA]O",
    "DISPOSITIVO",
    "INTIMA[ÇC][ÃA]O",
    "MANDADO",
    "CERTID[ÃA]O",
    "EDITAL",
    "PROCESSO",
    "ADVOGAD[OA]"
  ].join("|");

  const rolePattern = new RegExp(
    `\\b(?:R[ÉE]U|R[ÉE]|REQUERID[OA]|RECLAMAD[OA])\\s*:\\s*` +
      `(.+?)(?=\\s+(?:${terminators})\\b|$)`,
    "giu"
  );

  const names = [];
  const seen = new Set();

  for (const match of text.matchAll(rolePattern)) {
    const name = String(match[1] || "")
      .replace(/\s+(?:CPF|CNPJ)\s*:\s*[\d./-]+.*$/i, "")
      .replace(/\s+(?:e\s+outros|e\s+outr[oa]s)\s*$/i, "")
      .replace(/^[\-–—:;,.\s]+|[\-–—:;,\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name || name.length < 3 || name.length > 300) {
      continue;
    }

    if (!looksLikeCompanyName(name)) {
      continue;
    }

    const key = name.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }

  return names;
}


function extractCompaniesFromDjenPayload(payload) {
  const names = [];
  const seen = new Set();
  let link = "";

  const items = Array.isArray(payload && payload.items)
    ? payload.items
    : [];

  items.forEach((communication) => {
    if (!communication || typeof communication !== "object") {
      return;
    }

    if (!link && communication.link) {
      link = String(communication.link);
    }

    const recipients = Array.isArray(communication.destinatarios)
      ? communication.destinatarios
      : [];

    recipients.forEach((recipient) => {
      if (!recipient || typeof recipient !== "object") {
        return;
      }

      const pole = String(recipient.polo || "")
        .trim()
        .toUpperCase();

      if (
        pole !== "P" &&
        pole !== "PASSIVO" &&
        pole !== "POLO PASSIVO" &&
        pole !== "RÉU" &&
        pole !== "REU" &&
        pole !== "REQUERIDO" &&
        pole !== "RECLAMADO"
      ) {
        return;
      }

      const name = String(recipient.nome || "")
        .replace(/\s+/g, " ")
        .trim();

      if (!name || !looksLikeCompanyName(name)) {
        return;
      }

      const key = name.toUpperCase();

      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    });

    // Fallback textual: algumas comunicações do DJEN trazem somente o autor
    // em `destinatarios`, mas registram o polo passivo no corpo do documento.
    extractDefendantCompaniesFromText(communication.texto).forEach((name) => {
      const key = name.toUpperCase();

      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    });
  });

  return { names, link };
}


async function lookupCompaniesDirectly(row) {
  const numero = normalizeProcessDigits(row.numero_processo);

  if (numero.length !== 20) {
    return {
      tribunal: row.tribunal,
      numero_processo: row.numero_processo,
      status: "error",
      empresas_re: [],
      fonte: null,
      link: null
    };
  }

  const url = new URL(`${DJEN_PROXY}/comunicacoes`);
  url.searchParams.set("numeroProcesso", numero);
  url.searchParams.set("pagina", "1");
  url.searchParams.set("itensPorPagina", "50");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      payload.erro ||
      payload.message ||
      `DJEN HTTP ${response.status}`
    );
  }

  const extracted = extractCompaniesFromDjenPayload(payload);

  return {
    tribunal: row.tribunal,
    numero_processo: row.numero_processo,
    status: extracted.names.length ? "found" : "not_found",
    empresas_re: extracted.names,
    fonte: extracted.names.length ? "DJEN/CNJ" : null,
    link: extracted.link || null
  };
}


function updateCompanyRows(items) {
  updateCompanyRowsIn(loadedRows, items);
}


function scheduleCompanyEnrichment(delayMs = 0) {
  if (companyRetryTimer) {
    clearTimeout(companyRetryTimer);
    companyRetryTimer = null;
  }

  companyRetryTimer = setTimeout(() => {
    companyRetryTimer = null;
    enrichPendingCompanies();
  }, Math.max(0, Number(delayMs) || 0));
}


async function enrichPendingCompanies() {
  if (companyEnrichmentInProgress || fullRankingInProgress) {
    return;
  }

  const pending = loadedRows.filter((row) => {
    if (companyStatusIsFinal(row)) {
      return false;
    }

    const status = String(row.empresa_re_status || "");
    return !status || status === "pending" || status === "loading" ||
      status === "rate_limited";
  });

  if (!pending.length) {
    return;
  }

  const batch = pending.slice(0, 8);
  batch.forEach((row) => {
    row.empresa_re_status = "loading";
  });

  companyEnrichmentInProgress = true;
  renderRows();

  try {
    // Backend primeiro: ele consulta ProcessAnalysis/cache persistente e só
    // chama o DJEN quando o processo ainda não foi armazenado.
    const response = await fetch(
      `${API}/api/v1/searches/companies`,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: JSON.stringify({
          items: batch.map((row) => ({
            tribunal: row.tribunal,
            numero_processo: row.numero_processo
          }))
        })
      }
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }

    updateCompanyRows(Array.isArray(payload.items) ? payload.items : []);

    batch.forEach((row) => {
      if (row.empresa_re_status === "loading") {
        row.empresa_re_status = "error";
      }
    });

    renderRows();
    saveSearchState();

    const retryAfterSeconds = Number(payload.retry_after_seconds || 0);
    scheduleCompanyEnrichment(
      retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 250
    );
  } catch (error) {
    console.warn(
      "Backend indisponível para identificar empresas; usando DJEN direto como fallback:",
      error
    );

    const settled = await Promise.allSettled(
      batch.map((row) => lookupCompaniesDirectly(row))
    );

    const directItems = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        directItems.push(result.value);
      } else {
        batch[index].empresa_re_status = "error";
      }
    });

    updateCompanyRows(directItems);
    renderRows();
    saveSearchState();
    scheduleCompanyEnrichment(500);
  } finally {
    companyEnrichmentInProgress = false;
  }
}


async function executeSearch(options) {
  const append = Boolean(options && options.append);

  if (searchInProgress) {
    return;
  }

  clearError();
  showPartialErrors([]);

  let requestBody;

  try {
    requestBody = append
      ? buildLoadMoreRequest()
      : buildInitialSearchRequest();
  } catch (error) {
    showError(error.message);
    return;
  }

  const previousCursors = Object.assign(
    {},
    nextSearchAfterByTribunal
  );

  setSearchLoading(true, append);

  if (!append) {
    $("resultsCard").hidden = false;
    $("resultsTitle").textContent =
      "Pesquisando no DataJud...";
    $("resultsSubtitle").textContent = "";
    $("resultsBody").innerHTML = `
      <tr>
        <td colspan="9" class="empty-row">
          Consultando os tribunais selecionados...
        </td>
      </tr>
    `;
  }

  try {
    const response = await fetch(
      `${API}/api/v1/searches/multi`,
      {
        method: "POST",
        headers: Object.assign(
          {
            "Content-Type": "application/json"
          },
          authHeaders()
        ),
        body: JSON.stringify(requestBody)
      }
    );

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(
        payload.detail || `Erro HTTP ${response.status}`
      );
    }

    const incomingRows = Array.isArray(payload.items)
      ? payload.items
      : [];

    if (!append) {
      resetFullCompanyRanking();

      lastSearchRequest = Object.assign({}, requestBody, {
        search_after_by_tribunal: null
      });

      loadedRows = [];
      totalFound = Number(payload.total_found || 0);
      searchSummary = Array.isArray(payload.por_tribunal)
        ? payload.por_tribunal
        : [];
      nextSearchAfterByTribunal = Object.assign(
        {},
        payload.next_search_after_by_tribunal || {}
      );
    } else {
      const errors = Array.isArray(payload.errors)
        ? payload.errors
        : [];

      const errorTribunals = new Set(
        errors.map((item) => item.tribunal)
      );

      const returnedCursors =
        payload.next_search_after_by_tribunal || {};

      const updatedCursors = {};

      requestBody.tribunais.forEach((tribunal) => {
        if (errorTribunals.has(tribunal)) {
          if (previousCursors[tribunal]) {
            updatedCursors[tribunal] =
              previousCursors[tribunal];
          }

          return;
        }

        if (returnedCursors[tribunal]) {
          updatedCursors[tribunal] =
            returnedCursors[tribunal];
        }
      });

      nextSearchAfterByTribunal = updatedCursors;
    }

    loadedRows = mergeUniqueRows(
      loadedRows,
      incomingRows
    );

    errorCount = Number(
      payload.tribunais_com_erro || 0
    );

    renderSearchResults();
    showPartialErrors(payload.errors || []);
    saveSearchState();

    if (!append) {
      await loadSavedCompanyRanking();
    }

    scheduleCompanyEnrichment(0);
  } catch (error) {
    showError(
      error.message ||
        "Erro inesperado durante a pesquisa."
    );

    if (!append) {
      $("resultsTitle").textContent =
        "Não foi possível concluir a pesquisa";
    }
  } finally {
    setSearchLoading(false, append);
  }
}


function renderSearchResults() {
  $("resultsCard").hidden = false;

  $("resultsTitle").textContent =
    `${formatNumber(totalFound)} processos de saúde suplementar encontrados`;

  const activeSubject = String(
    (lastSearchRequest && lastSearchRequest.subject_query) || ""
  ).trim();

  const subjectDescription = activeSubject
    ? `Assunto: ${activeSubject}. `
    : "Todos os assuntos do segmento. ";

  $("resultsSubtitle").textContent =
    `${formatNumber(loadedRows.length)} registros carregados. ` +
    subjectDescription +
    "Recorte DataJud: planos de saúde / saúde suplementar; " +
    "as empresas rés são identificadas pelo DJEN nos resultados carregados.";

  renderMetrics();
  renderTribunalSummary();
  renderRows();
  updateLoadMoreButton();

  $("downloadCsv").disabled = !loadedRows.length;
}


function renderMetrics() {
  const successfulTribunals = searchSummary.filter(
    (item) => item.ok
  ).length;

  $("metricTotal").textContent = formatNumber(totalFound);
  $("metricTribunals").textContent = formatNumber(
    successfulTribunals
  );
  $("metricLoaded").textContent = formatNumber(
    loadedRows.length
  );
  $("metricErrors").textContent = formatNumber(errorCount);
}


function renderTribunalSummary() {
  if (!searchSummary.length) {
    $("tribunalSummary").innerHTML = "";
    return;
  }

  $("tribunalSummary").innerHTML = searchSummary
    .map((item) => {
      return `
        <div class="metric-card tribunal-summary-card">
          <span>${escapeHtml(item.tribunal || "—")}</span>
          <strong>${formatNumber(item.total || 0)}</strong>
          <small>
            ${item.ok
              ? "registros encontrados"
              : "falha na consulta"}
          </small>
        </div>
      `;
    })
    .join("");
}


function renderRows() {
  renderCompanyRanking();

  if (!loadedRows.length) {
    $("resultsBody").innerHTML = `
      <tr>
        <td colspan="9" class="empty-row">
          Nenhum registro encontrado com os parâmetros informados.
        </td>
      </tr>
    `;

    return;
  }

  $("resultsBody").innerHTML = loadedRows
    .map((row, index) => {
      const params = new URLSearchParams();
      params.set("tribunal", row.tribunal || "");
      params.set("numero", row.numero_processo || "");
      params.set("origem", "pesquisa");

      const processUrl =
        `./processo.html?${params.toString()}`;

      return `
        <tr>
          <td class="process-number">
            <a
              class="process-link"
              href="${escapeHtml(processUrl)}"
              data-row-index="${index}"
            >
              ${escapeHtml(row.numero_processo || "—")}
            </a>
          </td>

          <td>
            <span class="grade-badge">
              ${escapeHtml(row.tribunal || "—")}
            </span>
          </td>

          <td>
            ${escapeHtml(formatDate(row.data_ajuizamento))}
          </td>

          <td>
            <span class="grade-badge">
              ${escapeHtml(row.grau || "—")}
            </span>
          </td>

          <td>${escapeHtml(row.classe_nome || "—")}</td>

          <td>
            ${escapeHtml(row.orgao_julgador_nome || "—")}
          </td>

          <td class="company-cell">
            ${companyCellHtml(row)}
          </td>

          <td>
            ${escapeHtml(subjectsText(row.assuntos) || "—")}
          </td>

          <td class="process-actions">
            <a
              class="process-view-button process-link"
              href="${escapeHtml(processUrl)}"
              data-row-index="${index}"
            >
              Abrir ficha
            </a>
          </td>
        </tr>
      `;
    })
    .join("");
}


function updateLoadMoreButton() {
  const activeTribunals = Object.keys(
    nextSearchAfterByTribunal
  );

  const hasMore = activeTribunals.length > 0;

  $("loadMore").hidden = !hasMore;
  $("loadMore").disabled = !hasMore || searchInProgress;

  if (!searchInProgress) {
    $("loadMore").textContent = hasMore
      ? "Carregar mais"
      : "Sem mais resultados";
  }

  if (hasMore) {
    $("loadMoreInfo").textContent =
      `${activeTribunals.length} tribunal(is) ainda possuem resultados para carregar.`;
  } else if (lastSearchRequest) {
    $("loadMoreInfo").textContent =
      "Não há mais resultados disponíveis para esta pesquisa.";
  } else {
    $("loadMoreInfo").textContent =
      "Os resultados são carregados sob demanda.";
  }
}


function resetSearchResults() {
  resetFullCompanyRanking();
  loadedRows = [];
  nextSearchAfterByTribunal = {};
  lastSearchRequest = null;
  searchSummary = [];
  totalFound = 0;
  errorCount = 0;
  searchInProgress = false;

  $("resultsCard").hidden = true;
  $("downloadCsv").disabled = true;

  $("metricTotal").textContent = "—";
  $("metricTribunals").textContent = "—";
  $("metricLoaded").textContent = "—";
  $("metricErrors").textContent = "—";

  renderCompanyRanking();
  showPartialErrors([]);
  clearError();
  updateLoadMoreButton();
}


function clearSearch() {
  selectedTribunals.clear();

  if (
    tribunalCatalog.some((item) => item.sigla === "TJMT")
  ) {
    selectedTribunals.add("TJMT");
  }

  renderTribunals();
  setDefaultDates();

  $("subjectQuery").value = "Danos morais";
  $("pageSizePerTribunal").value = "10";

  resetSearchResults();
  sessionStorage.removeItem(SEARCH_STATE_KEY);
  sessionStorage.removeItem(LEGACY_SEARCH_STATE_KEY);
}


function csvCell(value) {
  const text = String(value == null ? "" : value)
    .replace(/"/g, '""');

  return `"${text}"`;
}


function downloadCsv() {
  if (!loadedRows.length) {
    return;
  }

  const header = [
    "tribunal",
    "numero_processo",
    "data_ajuizamento",
    "grau",
    "classe",
    "orgao_julgador",
    "empresa_re",
    "assuntos"
  ];

  const lines = [header.join(";")];

  loadedRows.forEach((row) => {
    const values = [
      row.tribunal,
      row.numero_processo,
      row.data_ajuizamento,
      row.grau,
      row.classe_nome,
      row.orgao_julgador_nome,
      (
        Array.isArray(row.empresa_re)
          ? row.empresa_re.join(" / ")
          : (row.empresa_re || "")
      ),
      subjectsText(row.assuntos)
    ].map(csvCell);

    lines.push(values.join(";"));
  });

  const blob = new Blob(
    ["\ufeff" + lines.join("\n")],
    {
      type: "text/csv;charset=utf-8"
    }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "veredicta_resultados_carregados.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}


function bindEvents() {
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    executeSearch({ append: false });
  });

  $("selectAllTribunals").addEventListener(
    "click",
    selectAllTribunals
  );

  $("clearTribunals").addEventListener(
    "click",
    clearTribunalSelection
  );

  $("clearSearch").addEventListener("click", clearSearch);

  $("loadMore").addEventListener("click", () => {
    executeSearch({ append: true });
  });

  $("fullCompanyScanButton").addEventListener(
    "click",
    processFullCompanyRanking
  );

  $("companyRankingList").addEventListener(
    "click",
    handleCompanyRankingClick
  );

  $("companyProcessesClose").addEventListener(
    "click",
    closeCompanyProcesses
  );

  $("companyProcessesModal").addEventListener(
    "click",
    (event) => {
      if (event.target === $("companyProcessesModal")) {
        closeCompanyProcesses();
      }
    }
  );

  $("companyProcessesBody").addEventListener(
    "click",
    handleCompanyModalClick
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("companyProcessesModal").hidden) {
      closeCompanyProcesses();
    }
  });

  $("downloadCsv").addEventListener("click", downloadCsv);

  $("resultsBody").addEventListener(
    "click",
    handleProcessLinkClick
  );

  [
    "dateFrom",
    "dateTo",
    "subjectQuery",
    "pageSizePerTribunal"
  ].forEach((id) => {
    $(id).addEventListener(
      "change",
      saveSearchState
    );
  });
}


function initializeApp() {
  sessionStorage.setItem(
    "veredicta_process_origin",
    "pesquisa"
  );

  bindEvents();
  setDefaultDates();
  resetSearchResults();
  checkHealth();
  initGoogleIdentity();
  loadTribunals();
}


document.addEventListener("DOMContentLoaded", initializeApp);
