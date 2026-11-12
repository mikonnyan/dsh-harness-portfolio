window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-relay-dispatch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const inject = ["slots", "sessions"];
		const LS = "dsh-relay-dispatch:sidebar-tree";
		const CSS = ".rdt-hidden{display:none!important}.rdt-tree-group{display:flex!important;flex-direction:column!important}.rdt-arrow{display:inline-block;width:14px;margin-right:2px;cursor:pointer;flex:none;text-align:center;font-size:10px;transition:transform .15s;opacity:.7;user-select:none}.rdt-arrow.open{transform:rotate(90deg)}.rdt-count{flex:none;font-size:11px;opacity:.6;margin-left:4px;pointer-events:none}[role=\"treeitem\"][data-rdt-depth=\"1\"]{padding-left:22px!important}[role=\"treeitem\"][data-rdt-depth=\"2\"]{padding-left:36px!important}[role=\"treeitem\"][data-rdt-depth=\"3\"]{padding-left:50px!important}[role=\"treeitem\"][data-rdt-depth=\"4\"]{padding-left:64px!important}";
		const eventsOf = (s) => (s && (typeof s.snapshotEvents === "function" ? s.snapshotEvents() : s.events)) || [];
		function billingBuckets(u) {
			if (!u) return null;
			const num = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
			const cached = num(u.cacheReadTokens ?? u.cachedInputTokens);
			const uncached = u.uncachedInputTokens != null ? num(u.uncachedInputTokens)
				: Object.prototype.hasOwnProperty.call(u, "cacheReadTokens") ? num(u.inputTokens)
				: Math.max(0, num(u.inputTokens ?? u.input) - cached);
			// outputTokens 是含思考的完整输出桶；仅在缺失时使用独立 reasoning 字段兜底。
			const output = num(u.outputTokens ?? u.reasoningTokens ?? u.thoughtsTokens ?? u.thinkingTokens);
			const cacheWrite = num(u.cacheWriteTokens);
			const tier = uncached + cached + cacheWrite;
			const inputRate = tier > 200000 ? 4 : 2, cacheRate = tier > 200000 ? 0.4 : 0.2, outputRate = tier > 200000 ? 24 : 12;
			return { cached, uncached, output, cacheWrite, inputRate, cacheRate, outputRate,
				cacheCost: cached * cacheRate / 1e6, inputCost: (uncached + cacheWrite) * inputRate / 1e6, outputCost: output * outputRate / 1e6 };
		}
		function formatTokensCompact(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			return n < 1000 ? String(Math.round(n)) : n < 1e6 ? scaled(n / 1e3) + "K" : scaled(n / 1e6) + "M";
		}
		function billingUsd(n) { return n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2); }
		function billingTotal(b) { return b ? b.cacheCost + b.inputCost + b.outputCost : 0; }
		function apply(ctx) {
			try { ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-relay-dispatch-sidebar-tree", order: 900, label: () => "relay-tree" }, () => null)), "relay-dispatch: overlay anchor"); } catch {}
			try {
				if (typeof document === "undefined" || !document.body) return;
				if (typeof window.__rdtSidebar === "function") { try { window.__rdtSidebar(); } catch {} }
				else if (window.__rdtSidebar) return;
				const store = ctx.sessions && ctx.sessions.list;
				if (!store || typeof store.getSnapshot !== "function") return;
				let open = new Set(), lastCur, manualClosed = new Set();
				const loadOpen = () => {
					try {
						const raw = localStorage.getItem(LS);
						if (raw !== null) {
							const parsed = JSON.parse(raw);
							if (Array.isArray(parsed)) open = new Set(parsed);
						}
					} catch {}
					return open;
				};
				loadOpen();
				const save = () => { try { localStorage.setItem(LS, JSON.stringify([...open])); } catch {} };
				const style = document.createElement("style");
				style.dataset.rdtStyle = "1";
				style.textContent = CSS;
				document.head.appendChild(style);
				const idOf = (el) => {
					const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$"));
					let f = k && el[k];
					for (let i = 0; f && i < 10; i++, f = f.return) {
						const n = f.memoizedProps && f.memoizedProps.node;
						if (n && typeof n.id === "string") return n.id;
					}
					return undefined;
				};
				// HoverCard 展开时会在外层 SPAN 内追加 role="status" 子节点（children.length 变为 2），不能用 children.length === 1 判断包装器
				const U = (el) => { const p = el.parentElement; return p && !p.hasAttribute("role") && p.tagName === "SPAN" ? p : el; };
				let busy = false, mo;
				const run = () => {
					if (busy || !document.body) return;
					busy = true;
					try {
						loadOpen();
						const snap = store.getSnapshot();
						const byId = (snap && snap.byId) || {};
						const rows = [...document.body.querySelectorAll('[role="treeitem"][aria-selected]')];
						const rowOf = new Map();
						for (const el of rows) {
							if (el.style.position === "absolute" || el.style.transform) continue; // virtualized: leave flat
							const id = idOf(el);
							if (id) rowOf.set(id, el);
						}
						const sameGroup = (a, b) => { const ea = rowOf.get(a), eb = rowOf.get(b); return Boolean(ea && eb && U(ea).parentElement && U(ea).parentElement === U(eb).parentElement); };
						const parentOf = (id) => { const p = byId[id] && byId[id].parentId; return p && p !== id && byId[p] && byId[p].origin !== "subagent" && sameGroup(p, id) ? p : undefined; };
						const kids = new Map();
						const groups = new Set();
						for (const [id, el] of rowOf) {
							const p = parentOf(id);
							if (p && rowOf.has(p)) {
								const g = U(rowOf.get(p)).parentElement;
								if (g && g === U(el).parentElement) {
									(kids.get(p) || kids.set(p, []).get(p)).push(id);
									groups.add(g);
								}
							}
						}
						// 当前选中的子会话：自动展开祖先
						const cur = snap && snap.current;
						if (cur !== lastCur) { lastCur = cur; manualClosed.clear(); }
						let changed = false;
						for (let a = cur && parentOf(cur), n = 0; a && n < 20; a = parentOf(a), n++) {
							if (!open.has(a) && !manualClosed.has(a)) { open.add(a); changed = true; }
						}
						if (changed) save();
						const depth = (id) => { let d = 0; for (let p = parentOf(id); p && d < 20; p = parentOf(p)) d++; return d; };
						const hiddenBy = (id) => { for (let p = parentOf(id); p; p = parentOf(p)) if (kids.has(p) && !open.has(p)) return true; return false; };
						const childIds = new Set([...kids.values()].flat());
						// 按容器计算 CSS order，不移动 React 管理的 DOM 节点
						const ord = new Map();
						let seq = 1;
						const walk = (id) => {
							if (ord.has(id)) return;
							ord.set(id, seq++);
							for (const cid of kids.get(id) || []) walk(cid);
						};
						for (const [id] of rowOf) if (!childIds.has(id)) walk(id);
						for (const [id] of rowOf) if (!ord.has(id)) walk(id);
						for (const g of document.body.querySelectorAll(".rdt-tree-group")) {
							if (!groups.has(g)) {
								g.classList.remove("rdt-tree-group");
								for (const ch of g.children) if (ch.style.order) ch.style.order = "";
							}
						}
						for (const g of groups) {
							if (!g.classList.contains("rdt-tree-group")) g.classList.add("rdt-tree-group");
							const first = g.firstElementChild;
							if (first && !first.hasAttribute("aria-selected") && (!first.querySelector || !first.querySelector("[aria-selected]")) && first.style.order !== "0") first.style.order = "0";
							const last = g.lastElementChild;
							if (last && last.tagName === "BUTTON" && last.style.order !== "99999") last.style.order = "99999";
						}
						for (const [id, el] of rowOf) {
							const u = U(el);
							if (u !== el) {
								if (el.classList.contains("rdt-hidden")) el.classList.remove("rdt-hidden");
								if (el.style.order) el.style.order = "";
							}
							const isChild = childIds.has(id);
							const d = isChild ? depth(id) : 0;
							const ds = d ? String(Math.min(d, 4)) : "";
							if ((el.dataset.rdtDepth || "") !== ds) {
								if (ds) el.dataset.rdtDepth = ds;
								else delete el.dataset.rdtDepth;
							}
							const pl = d ? 8 + 14 * d + "px" : "";
							if (el.style.paddingLeft !== pl) el.style.paddingLeft = pl;
							const wantOrder = groups.has(u.parentElement) ? String(ord.get(id) || 0) : "";
							if (u.style.order !== wantOrder) u.style.order = wantOrder;
							const hide = isChild && hiddenBy(id);
							if (u.classList.contains("rdt-hidden") !== hide) u.classList.toggle("rdt-hidden", hide);
							let ar = el.querySelector(":scope > .rdt-arrow");
							if (kids.has(id)) {
								if (!ar) {
									ar = document.createElement("span");
									ar.className = "rdt-arrow";
									ar.textContent = "▶";
									ar.dataset.rdtId = id;
									const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
									ar.addEventListener("dblclick", stop, true);
									ar.addEventListener("click", (e) => {
										e.stopPropagation(); e.preventDefault();
										const i = ar.dataset.rdtId;
										if (!i) return;
										loadOpen();
										if (open.has(i)) { open.delete(i); manualClosed.add(i); }
										else { open.add(i); manualClosed.delete(i); }
										save(); run();
									}, true);
									el.insertBefore(ar, el.firstChild);
									if (!el.querySelector(":scope > .rdt-count")) {
										const cnt = document.createElement("span");
										cnt.className = "rdt-count";
										el.insertBefore(cnt, el.querySelector(":scope > [class*=time]") || null);
									}
								}
								if (ar.dataset.rdtId !== id) ar.dataset.rdtId = id;
								const isOpen = open.has(id);
								if (ar.classList.contains("open") !== isOpen) ar.classList.toggle("open", isOpen);
								const cn = el.querySelector(":scope > .rdt-count");
								const ct = "(" + kids.get(id).length + ")";
								if (cn && cn.textContent !== ct) cn.textContent = ct;
							} else if (ar) {
								ar.remove();
								const cn = el.querySelector(":scope > .rdt-count"); if (cn) cn.remove();
							}
						}
						if (mo) mo.takeRecords();
					} catch (e) { /* 静默退回平铺 */ }
					busy = false;
				};
				const hasRowNode = (nodes) => {
					for (let i = 0; i < nodes.length; i++) {
						const n = nodes[i];
						if (!n || n.nodeType !== 1) continue;
						if (n.classList.contains("rdt-arrow") || n.classList.contains("rdt-count")) continue;
						if (n.getAttribute("role") === "treeitem" && n.hasAttribute("aria-selected")) return true;
						if (n.querySelector && n.querySelector('[role="treeitem"][aria-selected]')) return true;
					}
					return false;
				};
				mo = new MutationObserver((muts) => {
					for (let i = 0; i < muts.length; i++) {
						const m = muts[i];
						if (hasRowNode(m.addedNodes) || hasRowNode(m.removedNodes)) { run(); return; }
					}
				});
				mo.observe(document.body, { childList: true, subtree: true });
				const unsub = store.subscribe ? store.subscribe(() => { run(); Promise.resolve().then(run); }) : undefined;
				// gemini-4-argon，与 dsh-remote-dl turn-results.js formatGeminiArgonCost 同口径。
				// 标准档 prompt<=200k：未缓存 $2 / 缓存读 $0.20 / 输出 $12（每 1M）。
				// 长上下文 prompt>200k：$4 / $0.40 / $24。缓存写入按未缓存输入价。
				/* rdt-argon-cost */
				function formatGeminiArgonCost(usageOrTokens, tierPromptTokens) {
					const num = (v) => {
						const x = typeof v === "string" && String(v).trim() !== "" ? Number(v) : v;
						return typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : null;
					};
					const pick = (obj, keys) => {
						if (!obj) return null;
						for (const key of keys) {
							if (Object.prototype.hasOwnProperty.call(obj, key)) {
								const v = num(obj[key]);
								if (v != null) return v;
							}
						}
						return null;
					};
					const fmt = (usd, estimate) => {
						const abs = Math.abs(usd);
						const body = abs < 0.01 ? abs.toFixed(4) : abs < 1 ? abs.toFixed(3) : abs.toFixed(2);
						return (estimate ? "~" : "") + (usd < 0 ? "-$" : "$") + body;
					};
					const price = (uncached, cached, out, tier, estimate) => {
						if (uncached === 0 && cached === 0 && out === 0) return "";
						const long = tier > 200000;
						const input = long ? 4 : 2;
						const cache = long ? 0.4 : 0.2;
						const output = long ? 24 : 12;
						return fmt((uncached * input + cached * cache + out * output) / 1e6, estimate);
					};
					if (typeof usageOrTokens === "number" || typeof usageOrTokens === "string") {
						const n = num(usageOrTokens);
						if (n == null || n === 0) return "";
						const tier = typeof tierPromptTokens === "number" && Number.isFinite(tierPromptTokens) ? tierPromptTokens : n;
						return price(n, 0, 0, tier, true);
					}
					if (!usageOrTokens || typeof usageOrTokens !== "object") return "";
					const u = usageOrTokens;
					const uncachedNamed = pick(u, ["uncachedInputTokens"]);
					const prompt = pick(u, ["promptTokens", "promptTokenCount"]);
					const looseInput = pick(u, ["inputTokens", "input"]);
					const cache = pick(u, ["cacheReadTokens", "cachedInputTokens", "cachedTokens", "cacheRead", "cachedContentTokenCount"]);
					const cacheWrite = pick(u, ["cacheWriteTokens", "cacheWrite"]);
					const output = pick(u, ["outputTokens", "candidatesTokens", "output"]);
					const reasoning = pick(u, ["reasoningTokens", "thoughtsTokens", "thinkingTokens"]);
					const out = output ?? reasoning ?? 0;
					let uncached = 0, cached = 0, tier = 0, billed = false;
					if (uncachedNamed != null) {
						billed = true;
						uncached = uncachedNamed + (cacheWrite ?? 0);
						cached = cache ?? 0;
						tier = uncachedNamed + cached + (cacheWrite ?? 0);
					} else if (prompt != null) {
						billed = true;
						cached = Math.min(cache ?? 0, prompt);
						uncached = Math.max(0, prompt - cached) + (cacheWrite ?? 0);
						tier = prompt;
					} else if (looseInput != null || cache != null || cacheWrite != null || output != null || reasoning != null) {
						billed = true;
						// DSH 原生 usage.inputTokens 是未缓存桶；兼容把 input 当总输入的旧格式。
						const nativeBuckets = Object.prototype.hasOwnProperty.call(u, "cacheReadTokens") && Object.prototype.hasOwnProperty.call(u, "inputTokens");
						cached = Math.min(cache ?? 0, nativeBuckets ? (cache ?? 0) : (looseInput ?? cache ?? 0));
						uncached = (nativeBuckets ? (looseInput ?? 0) : Math.max(0, (looseInput ?? 0) - cached)) + (cacheWrite ?? 0);
						tier = uncached + cached;
					}
					if (!billed) {
						const only = pick(u, ["surfaceTokens", "pressureTokens", "totalTokens", "total", "used"]);
						if (only == null || only === 0) return "";
						const tierOnly = typeof tierPromptTokens === "number" && Number.isFinite(tierPromptTokens) ? tierPromptTokens : only;
						return price(only, 0, 0, tierOnly, true);
					}
					if (typeof tierPromptTokens === "number" && Number.isFinite(tierPromptTokens)) tier = tierPromptTokens;
					return price(uncached, cached, out, tier, false);
				}
				/* /rdt-argon-cost */
				const COST_CSS = "[data-rdt-cost]::after{content:attr(data-rdt-cost);font-variant-numeric:tabular-nums}.JObwrW_root[data-rdt-cost]::after{margin-left:4px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}.JObwrW_root:has([role=dialog])[data-rdt-cost]::after{content:none}.JObwrW_figures[data-rdt-cost]::after,.JObwrW_row dd[data-rdt-cost]::after,.FJxK0a_root span[data-rdt-cost]::after,.h8S2Va_metricToken[data-rdt-cost]::after,[role=tooltip][data-rdt-cost]::after,dd[data-rdt-cost]::after{margin-left:.3em}.JObwrW_panel{width:max-content!important;min-width:320px;max-width:min(440px,calc(100vw - 24px))}.rdt-billing{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3);font-size:12px;line-height:20px}.rdt-billing-title{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:4px}.rdt-billing-row{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}.rdt-billing-row>span:first-child{color:var(--dsw-alias-label-secondary)}.rdt-billing-row>span:last-child{color:var(--dsw-alias-label-primary);text-align:right;white-space:nowrap}.rdt-billing-total{margin-top:4px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l3)}";
				let costStyle = document.querySelector("style[data-rdt-cost-style]");
				if (!costStyle) {
					costStyle = document.createElement("style");
					costStyle.dataset.rdtCostStyle = "1";
					costStyle.textContent = COST_CSS;
					document.head.appendChild(costStyle);
				}
				const setCost = (el, text) => {
					if (!el) return;
					const next = text || "";
					if ((el.getAttribute("data-rdt-cost") || "") === next) return;
					if (next) el.setAttribute("data-rdt-cost", next);
					else el.removeAttribute("data-rdt-cost");
				};
				const setHint = (el, hint) => {
					if (!el) return;
					const cur = el.getAttribute("title") || "";
					const ours = cur.startsWith("gemini-4-argon");
					if (!hint) { if (ours) el.removeAttribute("title"); return; }
					if (!cur || ours) { if (cur !== hint) el.setAttribute("title", hint); }
				};
				const parseCompact = (text) => {
					const m = String(text || "").replace(/,/g, "").match(/~?\s*(\d+(?:\.\d+)?)\s*([KMB])?/i);
					if (!m) return null;
					const n = Number(m[1]);
					if (!Number.isFinite(n)) return null;
					const u = (m[2] || "").toUpperCase();
					return n * (u === "K" ? 1e3 : u === "M" ? 1e6 : u === "B" ? 1e9 : 1);
				};
				const ddNumber = (dd) => {
					let raw = "";
					for (const n of dd.childNodes) if (n.nodeType === 3) raw += n.nodeValue || "";
					raw = raw.replace(/tok/ig, "").replace(/,/g, "").replace(/~/g, "").trim();
					if (!raw || raw === "—" || raw === "-") return null;
					const v = Number(raw);
					return Number.isFinite(v) ? v : null;
				};
				// 空间占用只表示窗口容量；账单仅使用 provider 上报的 usage，绝不按窗口 Token 估算。
				function latestUsageEvent(sessionsSvc, sessionId) {
					if (!sessionsSvc || !sessionId) return null;
					let session = null;
					try {
						const binding = typeof sessionsSvc.binding === "function" ? sessionsSvc.binding(sessionId) : null;
						session = (binding && binding.session) || (typeof sessionsSvc.sessionOf === "function" ? sessionsSvc.sessionOf(sessionId) : null);
					} catch {}
					const events = eventsOf(session);
					for (let i = events.length - 1; i >= 0; i--) {
						const e = events[i], data = e && e.data;
						const u = e && e.type === "assistant/chunk" && data && data.chunk && data.chunk.type === "usage"
							? data.chunk.usage : e && e.type === "assistant/message" && data ? data.usage : undefined;
						if (u && typeof u === "object") return u;
					}
					return null;
				}
				function addBillingRow(panel, label, value, total) {
					const row = document.createElement("div");
					row.className = "rdt-billing-row" + (total ? " rdt-billing-total" : "");
					const dt = document.createElement("span"), dd = document.createElement("span");
					dt.textContent = label; dd.textContent = value; row.append(dt, dd); panel.appendChild(row);
				}
				function paintBilling(panel, latest, cumulative) {
					let box = panel.querySelector(":scope > .rdt-billing");
					const primary = latest || cumulative;
					if (!primary) { if (box) box.remove(); return; }
					if (!box) {
						box = document.createElement("section"); box.className = "rdt-billing"; box.setAttribute("aria-label", "计费账单明细");
						const title = document.createElement("div"); title.className = "rdt-billing-title"; title.textContent = "计费账单明细"; box.appendChild(title); panel.appendChild(box);
					} else while (box.children.length > 1) box.lastElementChild.remove();
					const percent = primary.cached + primary.uncached > 0 ? Math.round(primary.cached / (primary.cached + primary.uncached) * 100) : 0;
					addBillingRow(box, "缓存命中 (1折)", `~${formatTokensCompact(primary.cached)} (${percent}%) · $${billingUsd(primary.cacheCost)}`);
					addBillingRow(box, "新增输入", `~${formatTokensCompact(primary.uncached + primary.cacheWrite)} · $${billingUsd(primary.inputCost)}`);
					addBillingRow(box, "模型输出", `~${formatTokensCompact(primary.output)} · $${billingUsd(primary.outputCost)}`);
					const turnLabel = latest ? `本轮 $${billingUsd(billingTotal(latest))}` : "";
					const cumLabel = cumulative ? `累计 $${billingUsd(billingTotal(cumulative))}` : "";
					addBillingRow(box, latest ? "本轮实付 / 累计实付" : "累计实付", [turnLabel, cumLabel].filter(Boolean).join(" · "), true);
				}
				const fiberEntryId = (el) => {
					try {
						const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
						let f = k && el[k];
						for (let i = 0; f && i < 24; i++, f = f.return) {
							const p = f.memoizedProps || f.pendingProps;
							if (p && p.entry && typeof p.entry.id === "string") return p.entry.id;
						}
					} catch {}
					return undefined;
				};
				const dot = (s) => s ? " · " + s : "";
				const TOKEN_LABELS = new Set(["Input", "Cached", "Cache created", "Other", "Output", "Reasoning", "Content", "Tokens"]);
				let costOn = true, costRaf = 0;
				const paintCost = () => {
					if (!costOn || !document.body) return;
					let snap;
					try { snap = store.getSnapshot() || {}; } catch { snap = {}; }
					const byId = snap.byId || {};
					const cur = snap.current && byId[snap.current];
					const pv = (cur && cur.projectionValues) || {};
					const usage = pv.tokenUsage;
					const latestUsage = latestUsageEvent(ctx.sessions, snap.current);
					const latestBill = billingBuckets(latestUsage), cumulativeBill = billingBuckets(usage);
					const turnCost = latestBill ? "$" + billingUsd(billingTotal(latestBill)) : "";
					const actualCumCost = cumulativeBill ? "$" + billingUsd(billingTotal(cumulativeBill)) : "";
					const pressure = pv.contextPressure;
					const used = pressure && (typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : pressure.pressureTokens);
					const ctxCost = typeof used === "number" ? formatGeminiArgonCost(used) : "";
					const cumCost = usage ? formatGeminiArgonCost(usage) : "";
					const ctxTier = typeof used === "number" ? used : 0;
					const ringBadge = turnCost ? " · 本轮 " + turnCost : actualCumCost ? " · 累计 " + actualCumCost : dot(ctxCost);
					const roots = new Set(document.querySelectorAll(".JObwrW_root"));
					document.querySelectorAll('button[aria-haspopup="dialog"]').forEach((btn) => {
						const label = btn.getAttribute("aria-label") || "";
						if (!/上下文已用|of context used/.test(label)) return;
						const root = btn.parentElement;
						if (root) roots.add(root);
					});
					roots.forEach((el) => {
						setCost(el, ringBadge);
						setHint(el, turnCost ? "本轮实付 " + turnCost + (actualCumCost ? " · 累计实付 " + actualCumCost : "") : (actualCumCost ? "累计实付 " + actualCumCost : ""));
					});
					const figures = new Set(document.querySelectorAll(".JObwrW_figures"));
					roots.forEach((root) => {
						const known = root.querySelector(".JObwrW_figures");
						if (known) figures.add(known);
						else root.querySelectorAll("span").forEach((span) => {
							if (/^~\s*[\d.]+[KMB]?\s*\//i.test((span.textContent || "").trim())) figures.add(span);
						});
					});
					figures.forEach((el) => {
						const parts = [];
						if (turnCost) parts.push("本轮 " + turnCost);
						if (actualCumCost) parts.push("累计 " + actualCumCost);
						setCost(el, parts.length ? " · " + parts.join(" · ") : "");
					});
					const breakdown = pv.contextBreakdown || {};
					const byLabel = {
						"系统提示词": breakdown.systemTokens,
						"System prompt": breakdown.systemTokens,
						"工具": breakdown.toolsTokens,
						"Tools": breakdown.toolsTokens,
						"对话消息": breakdown.messageTokens,
						"Messages": breakdown.messageTokens
					};
					document.querySelectorAll(".JObwrW_row, .JObwrW_panel .JObwrW_row").forEach((row) => {
						const dd = row.querySelector("dd");
						if (!dd) return;
						const label = (row.querySelector("dt")?.textContent || "").trim();
						if (Object.prototype.hasOwnProperty.call(byLabel, label)) setCost(dd, "");
					});
					document.querySelectorAll('[role="dialog"]').forEach((dialog) => {
						const name = dialog.getAttribute("aria-label") || "";
						if (name !== "上下文已用" && name !== "of context used") return;
						dialog.querySelectorAll("dl div").forEach((row) => {
							if (row.closest(".JObwrW_row")) return;
							const dd = row.querySelector(":scope > dd");
							const label = (row.querySelector(":scope > dt")?.textContent || "").trim();
							if (dd && Object.prototype.hasOwnProperty.call(byLabel, label)) setCost(dd, "");
						});
						paintBilling(dialog, latestBill, cumulativeBill);
					});
					document.querySelectorAll(".FJxK0a_root span").forEach((el) => {
						if (el.classList.contains("FJxK0a_sep")) return;
						const t = el.textContent || "";
						if (!/tok/.test(t) || /tok\/s/.test(t) || !/输入|输出|Input|Output/.test(t)) { setCost(el, ""); return; }
						setCost(el, dot(cumCost));
						setHint(el, cumCost ? "gemini-4-argon 累计 " + cumCost : "");
					});
					let metrics = [...document.querySelectorAll(".h8S2Va_metricToken")];
					if (!metrics.length) metrics = [...document.querySelectorAll('[role="treeitem"] span')].filter((el) => /^\s*~?[\d.]+[KMB]?\s+tok\s*$/i.test(el.textContent || ""));
					metrics.forEach((el) => {
						const id = fiberEntryId(el);
						const u = id && byId[id] && byId[id].projectionValues && byId[id].projectionValues.tokenUsage;
						const s = u ? formatGeminiArgonCost(u) : formatGeminiArgonCost(parseCompact(el.textContent));
						setCost(el, dot(s));
					});
					document.querySelectorAll('[role="tooltip"]').forEach((el) => {
						const t = el.textContent || "";
						let extra = "";
						if (/上下文已用|of context used/.test(t)) extra = turnCost ? " · 本轮 " + turnCost : "";
						else if (/\btok\b/.test(t) && !/tok\/s/.test(t) && /输入|输出|Input|Output/.test(t)) extra = dot(cumCost);
						setCost(el, extra);
					});
					document.querySelectorAll("dl").forEach((dl) => {
						const rows = [];
						for (const div of dl.children) {
							if (!div || div.tagName !== "DIV") continue;
							const dt = div.querySelector(":scope > dt");
							const dd = div.querySelector(":scope > dd");
							if (!dt || !dd) continue;
							const label = (dt.textContent || "").trim();
							if (!TOKEN_LABELS.has(label)) continue;
							rows.push({ label, dd, n: ddNumber(dd) });
						}
						if (!rows.length) return;
						const get = (label) => rows.find((r) => r.label === label);
						const other = get("Other"), cached = get("Cached"), write = get("Cache created");
						const input = get("Input"), output = get("Output"), tokens = get("Tokens");
						const reasoning = get("Reasoning"), content = get("Content");
						let uncached = other && other.n != null ? other.n : null;
						if (uncached == null && input && input.n != null) uncached = Math.max(0, input.n - ((cached && cached.n) || 0) - ((write && write.n) || 0));
						const prompt = (uncached ?? 0) + ((cached && cached.n) || 0) + ((write && write.n) || 0);
						const tier = prompt > 0 ? prompt : ctxTier;
						const part = (row, obj) => {
							if (!row) return;
							if (row.n == null) { setCost(row.dd, ""); return; }
							const s = formatGeminiArgonCost(obj, tier);
							setCost(row.dd, dot(s));
						};
						const hasSplit = (other && other.n != null) || (cached && cached.n != null) || (write && write.n != null);
						if (input && hasSplit) part(input, { inputTokens: uncached ?? 0, cacheReadTokens: (cached && cached.n) || 0, cacheWriteTokens: (write && write.n) || 0 });
						else if (input) setCost(input.dd, input.n != null ? dot(formatGeminiArgonCost(input.n, tier || input.n)) : "");
						part(cached, { cacheReadTokens: cached ? cached.n : 0 });
						part(write, { cacheWriteTokens: write ? write.n : 0 });
						part(other, { inputTokens: other ? other.n : 0 });
						part(output, { outputTokens: output ? output.n : 0 });
						part(tokens, { outputTokens: tokens ? tokens.n : 0 });
						part(reasoning, { outputTokens: reasoning ? reasoning.n : 0 });
						part(content, { outputTokens: content ? content.n : 0 });
					});
				};
				const scheduleCost = () => {
					if (!costOn || costRaf) return;
					costRaf = requestAnimationFrame(() => { costRaf = 0; try { paintCost(); } catch { /* 金额层失败不影响会话树 */ } });
				};
				const moCost = new MutationObserver(scheduleCost);
				moCost.observe(document.body, { childList: true, subtree: true, characterData: true });
				const unsubCost = store.subscribe ? store.subscribe(scheduleCost) : undefined;
				try { paintCost(); } catch { /* 首帧金额失败不阻断侧栏 */ }
				const dispose = () => {
					try {
						costOn = false;
						if (costRaf) cancelAnimationFrame(costRaf);
						moCost.disconnect();
						unsubCost && unsubCost();
						costStyle && costStyle.remove();
						document.querySelectorAll("[data-rdt-cost]").forEach((el) => el.removeAttribute("data-rdt-cost"));
						document.querySelectorAll(".rdt-billing").forEach((el) => el.remove());
						document.querySelectorAll("[title]").forEach((el) => { const t = el.getAttribute("title") || ""; if (t.startsWith("gemini-4-argon") || t.startsWith("本轮实付")) el.removeAttribute("title"); });
						mo.disconnect();
						unsub && unsub();
						style.remove();
						if (window.__rdtSidebar === dispose) window.__rdtSidebar = false;
						document.body.querySelectorAll(".rdt-arrow,.rdt-count").forEach((x) => x.remove());
						document.body.querySelectorAll(".rdt-hidden").forEach((x) => x.classList.remove("rdt-hidden"));
						document.body.querySelectorAll(".rdt-tree-group").forEach((g) => {
							g.classList.remove("rdt-tree-group");
							for (const ch of g.children) ch.style.order = "";
						});
						document.body.querySelectorAll("[data-rdt-depth]").forEach((x) => {
							delete x.dataset.rdtDepth;
							x.style.paddingLeft = "";
						});
					} catch {}
				};
				window.__rdtSidebar = dispose;
				run();
				if (ctx.effect) ctx.effect(() => dispose, "relay-dispatch: sidebar tree");
			} catch (e) { /* 静默 */ }
		}
		exports.apply = apply;
		exports.inject = inject;
		// 纯计费函数供无 DOM 单测复用；不参与插件注入协议。
		exports.billingInternals = { billingBuckets, billingTotal, billingUsd, formatTokensCompact };
		exports.sidebarInternals = { eventsOf };
		return module.exports;
	}
});
