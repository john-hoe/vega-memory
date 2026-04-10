const state = {
  memories: [],
  wikiPages: [],
  selectedId: null,
  mode: "list",
  query: ""
};

const elements = {
  memoryCount: document.getElementById("memory-count"),
  dbSize: document.getElementById("db-size"),
  ollamaStatus: document.getElementById("ollama-status"),
  refreshStatus: document.getElementById("refresh-status"),
  resultsSummary: document.getElementById("results-summary"),
  tableBody: document.getElementById("memory-table"),
  tableMessage: document.getElementById("table-message"),
  detailBody: document.getElementById("detail-body"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  resetSearch: document.getElementById("reset-search"),
  wikiList: document.getElementById("wiki-list"),
  wikiSummary: document.getElementById("wiki-summary")
};

const formatTimestamp = (value) => {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const appendTextElement = (parent, tagName, text, className) => {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  element.textContent = text;
  parent.appendChild(element);
  return element;
};

const createTag = (text) => {
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = text;
  return tag;
};

const createSourceBadge = (text, subtle = false) => {
  const badge = document.createElement("span");
  badge.className = subtle ? "source-badge subtle" : "source-badge";
  badge.textContent = text;
  return badge;
};

const resetDetail = () => {
  elements.detailBody.replaceChildren();
  appendTextElement(
    elements.detailBody,
    "div",
    "Select a memory row to inspect content, tags, and metadata.",
    "empty-state"
  );
};

const fetchJson = async (path, init = {}) => {
  const response = await fetch(path, init);

  if (response.status === 401) {
    window.location.reload();
    throw new Error("Authentication required.");
  }

  if (!response.ok) {
    let detail = response.statusText;

    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") {
        detail = payload.error;
      }
    } catch {}

    throw new Error(detail || `Request failed with status ${response.status}`);
  }

  return response.json();
};

const updateRefreshStatus = (label) => {
  elements.refreshStatus.textContent = label;
};

const renderStats = (health) => {
  elements.memoryCount.textContent = String(health.memories ?? 0);
  elements.dbSize.textContent = `${Number(health.db_size_mb ?? 0).toFixed(2)} MB`;
  elements.ollamaStatus.textContent = health.ollama ? "Online" : "Offline";
};

const renderWiki = () => {
  elements.wikiList.replaceChildren();

  if (state.wikiPages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No wiki pages materialized yet.";
    elements.wikiList.appendChild(empty);
    elements.wikiSummary.textContent = "No wiki pages available.";
    return;
  }

  elements.wikiSummary.textContent = `Showing ${state.wikiPages.length} recent wiki updates`;

  for (const page of state.wikiPages) {
    const item = document.createElement("div");
    item.className = "wiki-item";
    appendTextElement(item, "h3", page.title || "Untitled Wiki Page", "wiki-item-title");
    appendTextElement(
      item,
      "div",
      `${page.status || "draft"} • ${page.project || "global"} • ${formatTimestamp(page.updated_at)}`,
      "wiki-item-meta"
    );
    elements.wikiList.appendChild(item);
  }
};

const renderMessage = (message, isError = false) => {
  if (!message) {
    elements.tableMessage.hidden = true;
    elements.tableMessage.textContent = "";
    elements.tableMessage.className = "message";
    return;
  }

  elements.tableMessage.hidden = false;
  elements.tableMessage.textContent = message;
  elements.tableMessage.className = isError ? "message error" : "message";
};

const renderDetail = (memory) => {
  if (!memory) {
    resetDetail();
    return;
  }

  const titleBlock = document.createElement("div");
  appendTextElement(titleBlock, "h3", memory.title || "Untitled Memory");

  const metadata = document.createElement("div");
  metadata.className = "detail-meta";
  for (const line of [
    `Type: ${memory.type || "-"}`,
    `Project: ${memory.project || "-"}`,
    `Importance: ${typeof memory.importance === "number" ? memory.importance.toFixed(2) : "-"}`,
    `Status: ${memory.status || "-"}`,
    `Verified: ${memory.verified || "-"}`,
    `Updated: ${formatTimestamp(memory.updated_at)}`,
    `Created: ${formatTimestamp(memory.created_at)}`,
    `Access Count: ${memory.access_count ?? 0}`
  ]) {
    appendTextElement(metadata, "div", line);
  }

  const contentSection = document.createElement("div");
  contentSection.className = "detail-section";
  appendTextElement(contentSection, "h4", "Content");
  const content = document.createElement("div");
  content.className = "detail-content";
  content.textContent = memory.content || "";
  contentSection.appendChild(content);

  const tagsSection = document.createElement("div");
  tagsSection.className = "detail-section";
  appendTextElement(tagsSection, "h4", "Tags");
  const tagList = document.createElement("div");
  tagList.className = "tag-list";
  const tags = Array.isArray(memory.tags) && memory.tags.length > 0 ? memory.tags : ["none"];
  for (const tag of tags) {
    tagList.appendChild(createTag(String(tag)));
  }
  tagsSection.appendChild(tagList);

  const sourceSection = document.createElement("div");
  sourceSection.className = "detail-section";
  sourceSection.id = "source-context";

  if (memory.source_context) {
    appendTextElement(sourceSection, "h4", "Source");

    const sourceInfo = document.createElement("div");
    sourceInfo.className = "source-info";

    const actorLabel = document.createElement("span");
    actorLabel.className = "label";
    actorLabel.textContent = "Actor:";
    const actorValue = document.createElement("span");
    actorValue.id = "source-actor";
    actorValue.textContent = memory.source_context.actor;

    const channelLabel = document.createElement("span");
    channelLabel.className = "label";
    channelLabel.textContent = "Channel:";
    const channelValue = document.createElement("span");
    channelValue.id = "source-channel";
    channelValue.textContent = memory.source_context.channel;

    const deviceLabel = document.createElement("span");
    deviceLabel.className = "label";
    deviceLabel.textContent = "Device:";
    const deviceValue = document.createElement("span");
    deviceValue.id = "source-device";
    deviceValue.textContent = `${memory.source_context.device_name} (${memory.source_context.device_id?.slice(0, 8) ?? "unknown"})`;

    const platformLabel = document.createElement("span");
    platformLabel.className = "label";
    platformLabel.textContent = "Platform:";
    const platformValue = document.createElement("span");
    platformValue.id = "source-platform";
    platformValue.textContent = memory.source_context.platform;

    sourceInfo.append(
      actorLabel,
      actorValue,
      document.createElement("br"),
      channelLabel,
      channelValue,
      document.createElement("br"),
      deviceLabel,
      deviceValue,
      document.createElement("br"),
      platformLabel,
      platformValue
    );

    sourceSection.appendChild(sourceInfo);
  } else {
    sourceSection.style.display = "none";
  }

  elements.detailBody.replaceChildren(titleBlock, metadata, contentSection, tagsSection, sourceSection);
};

const selectMemory = (memoryId) => {
  state.selectedId = memoryId;
  const selected = state.memories.find((memory) => memory.id === memoryId) || null;

  renderTable();
  renderDetail(selected);
};

const buildEmptyTableRow = (message) => {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.className = "empty-state";
  cell.textContent = message;
  row.appendChild(cell);
  return row;
};

const buildCell = (text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
};

const buildTitleCell = (memory) => {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "memory-title-cell";
  appendTextElement(wrapper, "div", memory.title || "Untitled Memory", "memory-title");

  if (memory.source_context) {
    const meta = document.createElement("div");
    meta.className = "memory-title-meta";
    meta.appendChild(createSourceBadge(memory.source_context.channel));
    meta.appendChild(createSourceBadge(memory.source_context.device_name, true));
    wrapper.appendChild(meta);
  }

  cell.appendChild(wrapper);
  return cell;
};

const buildTagCell = (text, className) => {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  cell.appendChild(badge);
  return cell;
};

const renderTable = () => {
  elements.tableBody.replaceChildren();

  if (state.memories.length === 0) {
    elements.tableBody.appendChild(buildEmptyTableRow("No memories available."));
    renderDetail(null);
    return;
  }

  for (const memory of state.memories) {
    const row = document.createElement("tr");

    if (memory.id === state.selectedId) {
      row.classList.add("selected");
    }

    row.appendChild(buildTitleCell(memory));
    row.appendChild(buildTagCell(memory.type || "-", "type-tag"));
    row.appendChild(buildTagCell(memory.project || "-", "project-tag"));
    row.appendChild(
      buildCell(typeof memory.importance === "number" ? memory.importance.toFixed(2) : "-")
    );
    row.appendChild(buildCell(formatTimestamp(memory.updated_at)));
    row.addEventListener("click", () => {
      selectMemory(memory.id);
    });

    elements.tableBody.appendChild(row);
  }

  if (!state.selectedId || !state.memories.some((memory) => memory.id === state.selectedId)) {
    state.selectedId = state.memories[0].id;
  }

  renderDetail(state.memories.find((memory) => memory.id === state.selectedId) || null);
};

const loadStats = async () => {
  const health = await fetchJson("/api/health");
  renderStats(health);
};

const loadMemories = async () => {
  updateRefreshStatus("Refreshing list");
  renderMessage("");

  const memories = await fetchJson("/api/list?limit=100&sort=updated_at%20DESC");

  state.mode = "list";
  state.query = "";
  state.memories = Array.isArray(memories) ? memories : [];
  elements.resultsSummary.textContent = `Showing ${state.memories.length} recent memories`;
  renderTable();
  updateRefreshStatus("Live");
};

const loadWikiPages = async () => {
  const pages = await fetchJson("/api/wiki/pages?limit=5");
  state.wikiPages = Array.isArray(pages) ? pages : [];
  renderWiki();
};

const searchMemories = async (query) => {
  updateRefreshStatus("Searching");
  renderMessage("");

  const results = await fetchJson("/api/recall", {
    body: JSON.stringify({
      limit: 25,
      min_similarity: 0,
      query
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  state.mode = "search";
  state.query = query;
  state.memories = Array.isArray(results) ? results : [];
  elements.resultsSummary.textContent = `Search results for "${query}" (${state.memories.length})`;
  renderTable();
  updateRefreshStatus("Live");
};

const refreshDashboard = async () => {
  try {
    await loadStats();
    await loadWikiPages();

    if (state.mode === "search" && state.query) {
      await searchMemories(state.query);
    } else {
      await loadMemories();
    }
  } catch (error) {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  }
};

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.searchInput.value.trim();

  try {
    await loadStats();
    await loadWikiPages();

    if (!query) {
      await loadMemories();
      return;
    }

    await searchMemories(query);
  } catch (error) {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  }
});

elements.resetSearch.addEventListener("click", async () => {
  elements.searchInput.value = "";
  await refreshDashboard();
});

setInterval(() => {
  void loadStats().catch((error) => {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  });
}, 30000);

void refreshDashboard();
