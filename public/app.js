const CUSTOM_FUNDS_STORAGE_KEY = "fund-dashboard:custom-funds:v1";
const FUND_SNAPSHOT_STORAGE_KEY = "fund-dashboard:latest-snapshot:v1";
const MAX_FUNDS = 30;

const elements = {
  addButton: document.querySelector("#add-fund-button"),
  addMessage: document.querySelector("#add-message"),
  clearButton: document.querySelector("#clear-button"),
  connectionDot: document.querySelector("#connection-dot"),
  failedCount: document.querySelector("#failed-count"),
  fundCodes: document.querySelector("#fund-codes"),
  fundSearch: document.querySelector("#fund-search"),
  fundSections: document.querySelector("#fund-sections"),
  notice: document.querySelector("#notice"),
  refreshButton: document.querySelector("#refresh-button"),
  staleWarning: document.querySelector("#stale-warning"),
  statusText: document.querySelector("#status-text"),
  successCount: document.querySelector("#success-count"),
  updatedTime: document.querySelector("#updated-time"),
};

function readSavedFunds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_FUNDS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const unique = new Map();
    parsed.forEach((fund) => {
      if (/^\d{6}$/.test(fund?.code)) {
        const name = typeof fund.name === "string" ? fund.name : "";
        unique.set(fund.code, {
          code: fund.code,
          name,
          category: name ? inferFundCategory(name) : "识别中",
        });
      }
    });
    return [...unique.values()].slice(0, MAX_FUNDS);
  } catch {
    return [];
  }
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCachedSnapshot(savedFunds) {
  try {
    const parsed = JSON.parse(localStorage.getItem(FUND_SNAPSHOT_STORAGE_KEY) || "null");
    if (!parsed || !Array.isArray(parsed.funds)) return { funds: [], updatedAt: null, dataUpdatedAt: null };
    const savedByCode = new Map(savedFunds.map((fund) => [fund.code, fund]));
    const funds = parsed.funds.flatMap((fund) => {
      const saved = savedByCode.get(fund?.code);
      if (!saved || typeof fund?.name !== "string") return [];
      const status = fund.status === "success" || fund.status === "failed" || fund.status === "stale" ? fund.status : "stale";
      return [{
        code: saved.code,
        name: saved.name || fund.name || saved.code,
        category: inferFundCategory(saved.name || fund.name || ""),
        estimatedNav: numberOrNull(fund.estimatedNav),
        estimatedChangePct: numberOrNull(fund.estimatedChangePct),
        previousNav: numberOrNull(fund.previousNav),
        officialNav: numberOrNull(fund.officialNav),
        officialChangePct: numberOrNull(fund.officialChangePct),
        navDate: typeof fund.navDate === "string" ? fund.navDate : null,
        estimateTime: typeof fund.estimateTime === "string" ? fund.estimateTime : null,
        source: typeof fund.source === "string" ? fund.source : "本地缓存",
        status,
        ...(typeof fund.error === "string" ? { error: fund.error } : {}),
      }];
    });
    return {
      funds,
      updatedAt: safeDate(parsed.updatedAt)?.toISOString() ?? null,
      dataUpdatedAt: safeDate(parsed.dataUpdatedAt)?.toISOString() ?? null,
    };
  } catch {
    return { funds: [], updatedAt: null, dataUpdatedAt: null };
  }
}

const initialSavedFunds = readSavedFunds();
const initialSnapshot = readCachedSnapshot(initialSavedFunds);

const state = {
  dataUpdatedAt: initialSnapshot.dataUpdatedAt,
  expandedCodes: new Set(),
  funds: initialSnapshot.funds,
  keyword: "",
  savedFunds: initialSavedFunds,
  sortDescending: true,
  updatedAt: initialSnapshot.updatedAt,
};

function saveFunds() {
  localStorage.setItem(CUSTOM_FUNDS_STORAGE_KEY, JSON.stringify(state.savedFunds));
}

function saveFundSnapshot() {
  try {
    localStorage.setItem(FUND_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      updatedAt: state.updatedAt,
      dataUpdatedAt: state.dataUpdatedAt,
      funds: state.funds,
    }));
  } catch {
    // 浏览器禁用或存储空间不足时，实时数据仍可正常使用。
  }
}

function safeDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = safeDate(value);
  if (!date) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatNav(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "--";
}

function formatChange(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function displayedChange(fund) {
  return numberOrNull(fund.estimatedChangePct) ?? numberOrNull(fund.officialChangePct);
}

function displayedNav(fund) {
  return numberOrNull(fund.estimatedNav) ?? numberOrNull(fund.officialNav);
}

function estimateUpdatedToday(fund) {
  const estimateTime = safeDate(fund.estimateTime);
  if (!estimateTime) return false;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  return format.format(estimateTime) === format.format(new Date());
}

function changeClass(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return "change neutral";
  return value > 0 ? "change positive" : "change negative";
}

function statusLabel(fund) {
  if (fund.status === "success") return "正常";
  if (fund.status === "stale") return "历史估值";
  return "失败";
}

function inferFundCategory(name) {
  const value = String(name || "").toLocaleUpperCase("zh-CN");
  if (/PCB|印制电路|电路板/.test(value)) return "PCB";
  if (/消费电子/.test(value)) return "消费电子";
  if (/半导体|芯片|集成电路/.test(value)) return "半导体";
  if (/人工智能|\bAI\b/.test(value)) return "人工智能";
  if (/机器人/.test(value)) return "机器人";
  if (/计算机|软件|信息技术|数字经济/.test(value)) return "数字科技";
  if (/通信|5G/.test(value)) return "通信";
  if (/电子/.test(value)) return "电子";
  if (/科技/.test(value)) return "科技";
  if (/新能源汽车|新能源车|智能汽车/.test(value)) return "新能源车";
  if (/光伏/.test(value)) return "光伏";
  if (/储能/.test(value)) return "储能";
  if (/新能源/.test(value)) return "新能源";
  if (/创新药|医药|医疗|生物/.test(value)) return "医药医疗";
  if (/白酒/.test(value)) return "白酒";
  if (/食品饮料/.test(value)) return "食品饮料";
  if (/消费/.test(value)) return "大消费";
  if (/军工|国防/.test(value)) return "军工";
  if (/证券/.test(value)) return "证券";
  if (/银行/.test(value)) return "银行";
  if (/金融/.test(value)) return "金融";
  if (/房地产|地产/.test(value)) return "地产";
  if (/稀土/.test(value)) return "稀土";
  if (/有色/.test(value)) return "有色金属";
  if (/煤炭/.test(value)) return "煤炭";
  if (/钢铁/.test(value)) return "钢铁";
  if (/黄金|贵金属|白银/.test(value)) return "黄金";
  if (/红利低波|低波|红利/.test(value)) return "红利低波";
  if (/纳斯达克|纳指/.test(value)) return "纳斯达克";
  if (/标普/.test(value)) return "标普";
  if (/恒生|港股/.test(value)) return "港股";
  if (/日经|日本/.test(value)) return "日本市场";
  if (/QDII|海外|全球/.test(value)) return "海外市场";
  if (/纯债|债券|短债|信用债|可转债|固收|债/.test(value)) return "债券";
  if (/量化/.test(value)) return "量化";
  if (/价值/.test(value)) return "价值";
  if (/成长/.test(value)) return "成长";
  if (/ETF|指数|联接|中证|上证|沪深|创业板|科创/.test(value)) return "宽基指数";
  return "综合主题";
}

function compareFunds(left, right) {
  const leftValue = displayedChange(left);
  const rightValue = displayedChange(right);
  if (leftValue === null && rightValue === null) return left.code.localeCompare(right.code);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return state.sortDescending ? rightValue - leftValue : leftValue - rightValue;
}

function visibleFunds() {
  const keyword = state.keyword.trim().toLocaleLowerCase("zh-CN");
  return state.funds.filter((fund) => {
    const keywordMatches = !keyword || fund.name.toLocaleLowerCase("zh-CN").includes(keyword) || fund.code.includes(keyword) || fund.category.toLocaleLowerCase("zh-CN").includes(keyword);
    return keywordMatches;
  });
}

function makeButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function makeCell(className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  return cell;
}

function toggleDetails(code) {
  if (state.expandedCodes.has(code)) state.expandedCodes.delete(code);
  else state.expandedCodes.add(code);
  renderFunds();
}

function removeFund(code) {
  state.savedFunds = state.savedFunds.filter((fund) => fund.code !== code);
  state.funds = state.funds.filter((fund) => fund.code !== code);
  if (!state.funds.length) {
    state.updatedAt = null;
    state.dataUpdatedAt = null;
  }
  state.expandedCodes.delete(code);
  saveFunds();
  saveFundSnapshot();
  render();
  showAddMessage("已删除基金", "success");
}

function createFundTable(funds) {
  const table = document.createElement("table");
  table.className = "fund-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["基金名称/代码", "估算涨幅", "估算净值"].forEach((label, index) => {
    const header = document.createElement("th");
    header.scope = "col";
    if (index === 1) {
      const sortButton = makeButton(`${label} ${state.sortDescending ? "↓" : "↑"}`, "sort-button", () => {
        state.sortDescending = !state.sortDescending;
        renderFunds();
      });
      header.append(sortButton);
    } else header.textContent = label;
    headRow.append(header);
  });
  head.append(headRow);
  const body = document.createElement("tbody");

  [...funds].sort(compareFunds).forEach((fund) => {
    const row = document.createElement("tr");
    row.className = "fund-main-row";
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", String(state.expandedCodes.has(fund.code)));
    row.addEventListener("click", () => toggleDetails(fund.code));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleDetails(fund.code); }
    });

    const identity = makeCell("fund-identity");
    const nameLine = document.createElement("div");
    nameLine.className = "fund-name-line";
    const name = document.createElement("span");
    name.className = "fund-name";
    name.textContent = fund.name || fund.code;
    nameLine.append(name);
    if (estimateUpdatedToday(fund)) {
      const updatedBadge = document.createElement("span");
      updatedBadge.className = "nav-updated-badge";
      updatedBadge.textContent = "今日估值";
      updatedBadge.title = "新浪今日盘中估值";
      nameLine.append(updatedBadge);
    }
    const meta = document.createElement("span");
    meta.className = "fund-meta";
    meta.textContent = `${fund.code} · ${fund.category}`;
    identity.append(nameLine, meta);

    const change = makeCell("change-cell");
    const changeBadge = document.createElement("span");
    const changeValue = displayedChange(fund);
    changeBadge.className = `change-badge ${changeClass(changeValue)}`;
    changeBadge.textContent = formatChange(changeValue);
    change.append(changeBadge);
    const nav = makeCell("nav-value");
    nav.textContent = formatNav(displayedNav(fund));
    row.append(identity, change, nav);

    const detailRow = document.createElement("tr");
    detailRow.className = "fund-detail-row";
    detailRow.hidden = !state.expandedCodes.has(fund.code);
    const detailCell = makeCell();
    detailCell.colSpan = 3;
    const details = document.createElement("div");
    details.className = "fund-details";
    [["参考净值", formatNav(fund.previousNav)], ["估值时间", formatDateTime(fund.estimateTime)], ["状态", statusLabel(fund)]].forEach(([label, value]) => {
      const item = document.createElement("div");
      item.className = "detail-item";
      const caption = document.createElement("span");
      caption.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      item.append(caption, strong);
      details.append(item);
    });
    const remove = makeButton("删除这只基金", "delete-fund", (event) => {
      event.stopPropagation();
      removeFund(fund.code);
    });
    details.append(remove);
    detailCell.append(details);
    detailRow.append(detailCell);
    body.append(row, detailRow);
  });
  table.append(head, body);
  return table;
}

function renderFunds() {
  const funds = visibleFunds();
  if (funds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.savedFunds.length ? "没有匹配的基金，请调整搜索关键词" : "暂无基金，请输入基金代码开始监控";
    elements.fundSections.replaceChildren(empty);
    return;
  }
  elements.fundSections.replaceChildren(createFundTable(funds));
}

function renderSummary() {
  const successCount = state.funds.filter((fund) => fund.status !== "failed").length;
  elements.updatedTime.textContent = formatDateTime(state.updatedAt);
  elements.successCount.textContent = String(successCount);
  elements.failedCount.textContent = String(state.funds.length - successCount);
  const updated = safeDate(state.dataUpdatedAt);
  elements.staleWarning.hidden = !updated || Date.now() - updated.getTime() <= 10 * 60 * 1000;
  elements.clearButton.disabled = state.savedFunds.length === 0;
}

function render() {
  renderSummary();
  renderFunds();
}

function setStatus(kind, message) {
  elements.connectionDot.className = `status-dot ${kind}`;
  elements.statusText.textContent = message;
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function showAddMessage(message, kind = "") {
  elements.addMessage.textContent = message;
  elements.addMessage.className = `add-message ${kind}`.trim();
}

async function readJson(response) {
  const body = await response.json();
  if (!response.ok || body.success !== true) throw new Error(body.message || `请求失败（${response.status}）`);
  return body.data;
}

async function loadFunds({ background = false } = {}) {
  if (!background) {
    setStatus("loading", "刷新中，请稍后");
    elements.refreshButton.textContent = "刷新中…";
  }
  elements.refreshButton.disabled = true;
  try {
    let estimates = [];
    if (state.savedFunds.length) {
      const codes = state.savedFunds.map((fund) => fund.code).join(",");
      const customResponse = await fetch(`/api/custom-funds?codes=${encodeURIComponent(codes)}`, { headers: { accept: "application/json" } });
      const customData = await readJson(customResponse);
      estimates = Array.isArray(customData?.funds) ? customData.funds : [];
    }
    const estimatesByCode = new Map(estimates.map((fund) => [fund.code, fund]));
    let savedDataChanged = false;
    state.funds = state.savedFunds.map((saved) => {
      const estimate = estimatesByCode.get(saved.code);
      if (!estimate) return { ...saved, name: saved.name || saved.code, estimatedNav: null, estimatedChangePct: null, previousNav: null, officialNav: null, officialChangePct: null, navDate: null, estimateTime: null, source: "--", status: "failed", error: "数据获取失败" };
      const name = estimate.name && estimate.name !== saved.code ? estimate.name : (saved.name || saved.code);
      const category = inferFundCategory(name);
      if (saved.name !== name || saved.category !== category) {
        saved.name = name;
        saved.category = category;
        savedDataChanged = true;
      }
      return { ...estimate, name, category };
    });
    if (savedDataChanged) saveFunds();
    const times = state.funds.map((fund) => {
      const estimateTime = safeDate(fund.estimateTime)?.getTime();
      if (Number.isFinite(estimateTime)) return estimateTime;
      return /^\d{4}-\d{2}-\d{2}$/.test(fund.navDate || "")
        ? Date.parse(`${fund.navDate}T15:00:00+08:00`)
        : NaN;
    }).filter(Number.isFinite);
    state.dataUpdatedAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    state.updatedAt = new Date().toISOString();
    saveFundSnapshot();
    render();
    showNotice("");
    setStatus("online", "数据已刷新");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    showNotice(`数据读取失败：${message}${state.funds.length ? "。已保留当前数据。" : "。"}`);
    setStatus("error", "读取失败");
    render();
  } finally {
    elements.refreshButton.disabled = false;
    if (!background) elements.refreshButton.textContent = "刷新数据";
  }
}

function parseCodes(value) {
  const tokens = value.split(/[\s,，;；]+/).map((token) => token.trim()).filter(Boolean);
  return { valid: [...new Set(tokens.filter((token) => /^\d{6}$/.test(token)))], invalid: [...new Set(tokens.filter((token) => !/^\d{6}$/.test(token)))] };
}

function addFunds() {
  const { valid, invalid } = parseCodes(elements.fundCodes.value);
  if (invalid.length) { showAddMessage(`以下代码格式不正确：${invalid.join("、")}`, "error"); return; }
  if (!valid.length) { showAddMessage("请输入至少一个六位基金代码", "error"); return; }
  const existing = new Set(state.savedFunds.map((fund) => fund.code));
  const additions = valid.filter((code) => !existing.has(code));
  if (!additions.length) { showAddMessage("输入的基金已经在列表中", "error"); return; }
  if (state.savedFunds.length + additions.length > MAX_FUNDS) { showAddMessage(`最多保存 ${MAX_FUNDS} 只基金`, "error"); return; }
  additions.forEach((code) => state.savedFunds.push({ code, name: "", category: "识别中" }));
  saveFunds();
  elements.fundCodes.value = "";
  showAddMessage(`已添加 ${additions.length} 只基金`, "success");
  void loadFunds();
}

elements.addButton.addEventListener("click", addFunds);
elements.fundCodes.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addFunds();
});
elements.clearButton.addEventListener("click", () => {
  if (!state.savedFunds.length || !window.confirm("确定清空当前浏览器中的全部自选基金吗？")) return;
  state.savedFunds = [];
  state.funds = [];
  state.updatedAt = null;
  state.dataUpdatedAt = null;
  state.expandedCodes.clear();
  saveFunds();
  localStorage.removeItem(FUND_SNAPSHOT_STORAGE_KEY);
  render();
  showAddMessage("已清空全部基金", "success");
});
elements.fundSearch.addEventListener("input", (event) => { state.keyword = event.target.value; renderFunds(); });
elements.refreshButton.addEventListener("click", () => void loadFunds());

render();
if (state.funds.length) {
  setStatus("loading", "已显示缓存，正在更新");
  void loadFunds({ background: true });
} else {
  void loadFunds();
}
window.setInterval(() => void loadFunds({ background: true }), 60_000);
