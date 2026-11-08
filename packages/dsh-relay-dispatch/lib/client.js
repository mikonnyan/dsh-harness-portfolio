window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-relay-dispatch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const inject = ["slots", "sessions"];
		const LS = "dsh-relay-dispatch:sidebar-tree";
		const CSS = ".rdt-hidden{display:none!important}.rdt-tree-group{display:flex!important;flex-direction:column!important}.rdt-arrow{display:inline-block;width:14px;margin-right:2px;cursor:pointer;flex:none;text-align:center;font-size:10px;transition:transform .15s;opacity:.7;user-select:none}.rdt-arrow.open{transform:rotate(90deg)}.rdt-count{flex:none;font-size:11px;opacity:.6;margin-left:4px;pointer-events:none}[role=\"treeitem\"][data-rdt-depth=\"1\"]{padding-left:22px!important}[role=\"treeitem\"][data-rdt-depth=\"2\"]{padding-left:36px!important}[role=\"treeitem\"][data-rdt-depth=\"3\"]{padding-left:50px!important}[role=\"treeitem\"][data-rdt-depth=\"4\"]{padding-left:64px!important}";
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
						const parentOf = (id) => { const p = byId[id] && byId[id].parentId; return p && p !== id && byId[p] && byId[p].origin !== "subagent" ? p : undefined; };
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
				const dispose = () => {
					try {
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
		return module.exports;
	}
});
