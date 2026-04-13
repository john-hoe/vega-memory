const state = {
  memories: [],
  wikiPages: [],
  dashboard: null,
  selectedId: null,
  mode: "list",
  query: ""
};

const elements = {
  memoryCount: document.getElementById("memory-count"),
  dbSize: document.getElementById("db-size"),
  ollamaStatus: document.getElementById("ollama-status"),
  newMemories: document.getElementById("new-memories"),
  runtimeReadiness: document.getElementById("runtime-readiness"),
  configuredSurfaces: document.getElementById("configured-surfaces"),
  refreshStatus: document.getElementById("refresh-status"),
  resultsSummary: document.getElementById("results-summary"),
  tableBody: document.getElementById("memory-table"),
  tableMessage: document.getElementById("table-message"),
  detailBody: document.getElementById("detail-body"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  resetSearch: document.getElementById("reset-search"),
  impactSummary: document.getElementById("impact-summary"),
  impactList: document.getElementById("impact-list"),
  weeklySummary: document.getElementById("weekly-summary"),
  weeklyList: document.getElementById("weekly-list"),
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

const createSignalItem = (title, metaText, badges = []) => {
  const item = document.createElement("div");
  item.className = "signal-item";
  appendTextElement(item, "h3", title, "signal-item-title");
  appendTextElement(item, "div", metaText, "signal-item-meta");

  if (badges.length > 0) {
    const badgeList = document.createElement("div");
    badgeList.className = "signal-badges";
    for (const badge of badges) {
      badgeList.appendChild(createTag(badge));
    }
    item.appendChild(badgeList);
  }

  return item;
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

const renderStats = (health, impact) => {
  elements.memoryCount.textContent = String(health.memories ?? 0);
  elements.dbSize.textContent = `${Number(health.db_size_mb ?? 0).toFixed(2)} MB`;
  elements.ollamaStatus.textContent = health.ollama ? "Online" : "Offline";
  elements.newMemories.textContent = String(impact?.new_memories_this_week ?? 0);
  elements.runtimeReadiness.textContent = (impact?.runtime_readiness ?? "unknown").toUpperCase();
  const configuredCount = Object.values(impact?.setup_surface_coverage ?? {}).filter(
    (stateValue) => stateValue === "configured"
  ).length;
  elements.configuredSurfaces.textContent = String(configuredCount);
};

const renderImpact = (impact) => {
  elements.impactList.replaceChildren();

  if (!impact) {
    elements.impactSummary.textContent = "No impact payload available.";
    elements.impactList.appendChild(
      createSignalItem("No impact data", "The dashboard route did not return an impact payload.")
    );
    return;
  }

  const surfaceCoverage = impact.setup_surface_coverage ?? {};
  const configuredTargets = Object.entries(surfaceCoverage)
    .filter(([, stateValue]) => stateValue === "configured")
    .map(([target]) => target);
  const coverageBadges = Object.entries(surfaceCoverage).map(
    ([target, stateValue]) => `${target}: ${stateValue}`
  );

  elements.impactSummary.textContent =
    `7-day snapshot • runtime ${impact.runtime_readiness ?? "unknown"} • ${impact.new_memories_this_week} new memories`;

  if (impact.conclusion) {
    elements.impactList.appendChild(
      createSignalItem(
        "System Conclusion",
        `${impact.conclusion.headline} ${impact.conclusion.detail}`
      )
    );
  }

  if (impact.runtime_readiness_detail) {
    const readinessBadges = [
      ...impact.runtime_readiness_detail.reasons,
      ...impact.runtime_readiness_detail.suggestions.slice(0, 2)
    ];
    elements.impactList.appendChild(
      createSignalItem(
        "Runtime Readiness",
        impact.runtime_readiness_detail.summary,
        readinessBadges
      )
    );
  }

  elements.impactList.appendChild(
    createSignalItem(
      "Adoption Coverage",
      configuredTargets.length > 0
        ? `Configured surfaces: ${configuredTargets.join(", ")}`
        : "No fully configured surfaces yet.",
      coverageBadges
    )
  );

  if (Array.isArray(impact.top_reused_memories) && impact.top_reused_memories.length > 0) {
    for (const memory of impact.top_reused_memories.slice(0, 5)) {
      elements.impactList.appendChild(
        createSignalItem(
          memory.title || "Untitled memory",
          memory.explanation ||
            `${memory.project || "global"} • ${memory.type || "unknown"} • access count ${memory.access_count ?? 0}`,
          [
            `project: ${memory.project || "global"}`,
            `type: ${memory.type || "unknown"}`
          ]
        )
      );
    }
  } else {
    elements.impactList.appendChild(
      createSignalItem(
        "Top Reused Memories",
        "No reuse signal has been recorded yet."
      )
    );
  }

  if (Array.isArray(impact.recommended_actions) && impact.recommended_actions.length > 0) {
    elements.impactList.appendChild(
      createSignalItem(
        "Recommended Next Actions",
        impact.recommended_actions.map((action) => `${action.title}: ${action.reason}`).join(" • "),
        impact.recommended_actions.map((action) => action.area)
      )
    );
  }
};

const renderWeekly = (weekly) => {
  elements.weeklyList.replaceChildren();

  if (!weekly) {
    elements.weeklySummary.textContent = "No weekly payload available.";
    elements.weeklyList.appendChild(
      createSignalItem("No weekly data", "The dashboard route did not return a weekly summary.")
    );
    return;
  }

  elements.weeklySummary.textContent =
    `${weekly.window_days}-day summary • ${weekly.api_calls_total} API calls • peak hour ${weekly.peak_hour || "none"}`;

  if (weekly.overview) {
    elements.weeklyList.appendChild(
      createSignalItem(
        "Weekly Overview",
        `${weekly.overview.headline} ${weekly.overview.detail}`
      )
    );
  }

  const memoryMixBadges = Object.entries(weekly.memory_mix ?? {}).map(
    ([type, count]) => `${type}: ${count}`
  );
  elements.weeklyList.appendChild(
    createSignalItem(
      "Memory Mix",
      `${weekly.new_memories_this_week} new memories across ${weekly.active_projects} active projects`,
      memoryMixBadges
    )
  );

  const resultTypeBadges = Object.entries(weekly.result_type_hits ?? {}).map(
    ([type, count]) => `${type}: ${count}`
  );
  elements.weeklyList.appendChild(
    createSignalItem(
      "Pitfall / Decision Hits",
      "Result-type hit counts across recall and recall_stream in the current weekly window.",
      resultTypeBadges
    )
  );

  if (Array.isArray(weekly.top_search_queries) && weekly.top_search_queries.length > 0) {
    elements.weeklyList.appendChild(
      createSignalItem(
        "Top Search Queries",
        weekly.top_search_queries
          .map((entry) => `${entry.query} (${entry.count})`)
          .join(" • ")
      )
    );
  } else {
    elements.weeklyList.appendChild(
      createSignalItem(
        "Top Search Queries",
        "No search query telemetry available yet."
      )
    );
  }

  if (Array.isArray(weekly.key_signals) && weekly.key_signals.length > 0) {
    elements.weeklyList.appendChild(
      createSignalItem(
        "Most Valuable Signals",
        weekly.key_signals.join(" • ")
      )
    );
  }

  if (Array.isArray(weekly.recommended_actions) && weekly.recommended_actions.length > 0) {
    elements.weeklyList.appendChild(
      createSignalItem(
        "Recommended Next Actions",
        weekly.recommended_actions.map((action) => `${action.title}: ${action.reason}`).join(" • "),
        weekly.recommended_actions.map((action) => action.area)
      )
    );
  }
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

const loadDashboardReport = async () => {
  const dashboard = await fetchJson("/api/admin/dashboard");
  state.dashboard = dashboard;
  renderStats(dashboard.health ?? {}, dashboard.impact ?? null);
  renderImpact(dashboard.impact ?? null);
  renderWeekly(dashboard.weekly ?? null);
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
    await loadDashboardReport();
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
    await loadDashboardReport();
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
  void loadDashboardReport().catch((error) => {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  });
}, 30000);

void refreshDashboard();
