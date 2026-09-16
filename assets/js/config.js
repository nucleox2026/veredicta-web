(() => {
  const host = window.location.hostname || "localhost";

  const isPrivateNetworkHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    (!host.includes(".") && host !== "");

  const localApiBaseUrl = `http://${host}:8001`;

  window.VEREDICTA_CONFIG = {
    // Em localhost/IP da rede local, usa automaticamente o backend da mesma maquina na porta 8001.
    // No GitHub Pages ou em outro host publico, continua usando a API publicada.
    API_BASE_URL: isPrivateNetworkHost
      ? localApiBaseUrl
      : "https://veredicta-api.onrender.com",
    DJEN_PROXY_URL:
      "https://veredicta-djen-br.guilherme-moussalem.workers.dev",
    GOOGLE_CLIENT_ID: "",
  };
})();
