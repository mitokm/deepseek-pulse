window.__ModuleLoader__.load({
	id: "deepseek-pulse",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const R = React.createElement ? React : React.default;
		const { createElement: h, useEffect, useRef, useState } = R;

		/** Shared by the sidebar entry and the main panel it opens. */
		const PANEL_ID = "pulse";
		const MUTE_KEY = "pulse.peak.mutedUntil";
		const DOCK_KEY = "pulse.dock.collapsed";
		const POLL_MS = 30_000;

		const peakColor = "#f5a524";
		const offColor = "#34d399";
		const textColor = "#e8eefb";
		const mutedColor = "#8595b0";
		const faintColor = "#5b6b86";
		const cardColor = "#0d1524";
		const lineColor = "rgba(148,163,184,0.16)";

		function fmtTokens(value) {
			if (value == null || !Number.isFinite(value)) return "—";
			if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
			return String(Math.round(value));
		}

		function fmtMoney(value, digits) {
			if (value == null || !Number.isFinite(value)) return "—";
			const abs = Math.abs(value);
			const d = digits ?? (abs < 1 ? 3 : 2);
			return `$${value.toFixed(d)}`;
		}

		function fmtDuration(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (days > 0) return `${days} ngày ${hours} giờ`;
			if (hours > 0) return `${hours} giờ ${String(minutes).padStart(2, "0")} phút`;
			if (minutes > 0) return `${minutes} phút`;
			return `${total % 60} giây`;
		}

		/** Sidebar glyph: a small activity wave, matching the dashboard mark. */
		function PulseIcon({ size = 18 }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
				},
				h("path", { d: "M3 13h4l2.5-7 4 14 2.5-7h5" }),
			);
		}

		/**
		 * The panel is a same-origin frame over the dashboard the Host half
		 * serves at /pulse: one implementation, rendered inside the GUI.
		 */
		function PulsePanel() {
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						flex: "1 1 auto",
						height: "100%",
						minHeight: 0,
						background: "#060a13",
					},
				},
				h("iframe", {
					src: "/pulse/?embed=1",
					title: "DeepSeek Pulse",
					style: {
						flex: "1 1 auto",
						width: "100%",
						height: "100%",
						minHeight: 480,
						border: "0",
						display: "block",
						background: "#060a13",
						colorScheme: "dark",
					},
				}),
			);
		}

		function readStorage(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : raw;
			} catch {
				return fallback;
			}
		}

		function writeStorage(key, value) {
			try {
				window.localStorage.setItem(key, String(value));
			} catch {
				/* storage may be unavailable */
			}
		}

		function clockText(ms, timeZone) {
			try {
				return new Intl.DateTimeFormat("vi-VN", {
					timeZone,
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}).format(new Date(ms));
			} catch {
				return "";
			}
		}

		/** Show one OS notification; silently no-op when permission is missing. */
		function notifyPeak(info, msLeft) {
			try {
				if (typeof Notification === "undefined") return;
				if (Notification.permission === "default") {
					const request = Notification.requestPermission();
					if (request && typeof request.catch === "function") request.catch(() => {});
				}
				if (Notification.permission !== "granted") return;
				const minutes = Math.max(1, Math.round(msLeft / 60_000));
				const at = clockText(info.nextChangeAt, info.timeZone);
				new Notification("Sắp vào giờ cao điểm", {
					body: `Còn ~${minutes} phút. Từ ${at} token tính giá gấp đôi — nên dời việc nặng sang sau.`,
					tag: "deepseek-pulse-peak",
					silent: false,
				});
			} catch {
				/* notifications are optional */
			}
		}

		/**
		 * Balance-drop notifications: one OS notification each time the account
		 * balance falls by the configured step (default $1, minimum $0.10). The
		 * step is shared with the dashboard panel through localStorage.
		 */
		const BAL_STEP_KEY = "pulse.balance.step";
		const BAL_BASE_KEY = "pulse.balance.baseline";
		const BAL_MIN_STEP = 0.1;
		const BAL_DEFAULT_STEP = 1;

		function requestNotificationPermission() {
			try {
				if (typeof Notification === "undefined" || Notification.permission !== "default") return;
				const request = Notification.requestPermission();
				if (request && typeof request.catch === "function") request.catch(() => {});
			} catch {
				/* notifications unavailable */
			}
		}

		function clampBalanceStep(value) {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0) return BAL_DEFAULT_STEP;
			return Math.max(BAL_MIN_STEP, Math.round(parsed * 100) / 100);
		}

		function readBalanceStep() {
			const raw = readStorage(BAL_STEP_KEY, "");
			return raw === "" ? BAL_DEFAULT_STEP : clampBalanceStep(raw);
		}

		function readBalanceBaseline() {
			const raw = Number(readStorage(BAL_BASE_KEY, ""));
			return Number.isFinite(raw) && raw > 0 ? raw : null;
		}

		function writeBalanceBaseline(value) {
			writeStorage(BAL_BASE_KEY, String(Math.round(value * 1e6) / 1e6));
		}

		/**
		 * Compare one balance sample with the stored baseline and notify once the
		 * configured step is crossed. Returns the event it announced, if any.
		 */
		function maybeNotifyBalanceDrop(balance) {
			if (!balance || !balance.connected || !Number.isFinite(balance.total)) return null;
			const step = readBalanceStep();
			const baseline = readBalanceBaseline();
			if (baseline === null) {
				writeBalanceBaseline(balance.total);
				return null;
			}
			const drop = baseline - balance.total;
			if (drop <= 0) {
				if (drop < -0.005) writeBalanceBaseline(balance.total); // topped up: rebase silently
				return null;
			}
			if (drop < step) return null;
			writeBalanceBaseline(balance.total);
			const event = { drop, total: balance.total, step };
			try {
				if (typeof Notification !== "undefined" && Notification.permission === "granted") {
					new Notification(`Số dư giảm $${drop.toFixed(2)}`, {
						body: `Còn $${balance.total.toFixed(2)} · ngưỡng báo $${step.toFixed(2)}`,
						tag: "deepseek-pulse-balance",
					});
				}
			} catch {
				/* notifications are optional */
			}
			return event;
		}

		/**
		 * Always-mounted overlay: polls the Host for the next price transition and
		 * raises one desktop notification plus an in-app card inside the warning
		 * window.
		 */
		function PeakAlert() {
			const [info, setInfo] = useState(null);
			const [mutedUntil, setMutedUntil] = useState(() => Number(readStorage(MUTE_KEY, 0)) || 0);
			const notified = useRef(new Set());

			useEffect(() => {
				let alive = true;
				async function poll() {
					try {
						const response = await fetch("/pulse/api/peak", { headers: { accept: "application/json" } });
						if (!response.ok) return;
						const next = await response.json();
						if (alive) setInfo(next);
					} catch {
						/* Host may be restarting; the next poll retries. */
					}
				}
				poll();
				const timer = window.setInterval(poll, POLL_MS);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);

			const target = info && info.nextChangeAt ? info.nextChangeAt : 0;
			const msLeft = target ? target - Date.now() : Number.POSITIVE_INFINITY;
			const active = Boolean(
				info &&
					!info.isPeak &&
					info.nextIsPeak &&
					msLeft > 0 &&
					msLeft <= info.warnBeforeMs &&
					target > mutedUntil,
			);

			useEffect(() => {
				if (!active || !info) return;
				const key = String(info.nextChangeAt);
				if (notified.current.has(key)) return;
				notified.current.add(key);
				notifyPeak(info, msLeft);
			}, [active, info, msLeft]);

			if (!active || !info) return null;

			const minutes = Math.max(1, Math.round(msLeft / 60_000));
			const at = clockText(info.nextChangeAt, info.timeZone);

			const dismiss = () => {
				setMutedUntil(target);
				writeStorage(MUTE_KEY, target);
			};
			const snooze = () => {
				const until = Date.now() + 60 * 60_000;
				setMutedUntil(until);
				writeStorage(MUTE_KEY, until);
			};

			const button = (label, onClick) =>
				h(
					"button",
					{
						type: "button",
						onClick,
						style: {
							border: "1px solid rgba(148,163,184,0.28)",
							background: "rgba(148,163,184,0.08)",
							color: textColor,
							borderRadius: 8,
							padding: "5px 10px",
							font: "inherit",
							fontSize: 12,
							cursor: "pointer",
						},
					},
					label,
				);

			return h(
				"div",
				{
					style: {
						position: "fixed",
						right: 18,
						bottom: 18,
						zIndex: 80,
						maxWidth: 340,
						pointerEvents: "auto",
						background: cardColor,
						border: "1px solid rgba(245,165,36,0.45)",
						borderRadius: 12,
						padding: "12px 14px",
						boxShadow: "0 18px 40px -18px rgba(0,0,0,0.85)",
						color: textColor,
						fontFamily: "inherit",
					},
				},
				h(
					"div",
					{
						style: {
							fontSize: 11,
							letterSpacing: "0.08em",
							textTransform: "uppercase",
							fontWeight: 700,
							color: peakColor,
						},
					},
					"Sắp vào giờ cao điểm",
				),
				h(
					"div",
					{ style: { fontSize: 13, lineHeight: 1.45, marginTop: 5, color: textColor } },
					`Còn ~${minutes} phút. Từ ${at} giá token gấp đôi (thấp điểm → cao điểm).`,
				),
				h(
					"div",
					{ style: { display: "flex", gap: 8, marginTop: 10 } },
					button("Đã hiểu", dismiss),
					button("Tắt 1 giờ", snooze),
				),
				h(
					"div",
					{ style: { fontSize: 11, color: mutedColor, marginTop: 8 } },
					"Đổi ngưỡng cảnh báo trong config của plugin (peakWarningMinutes).",
				),
			);
		}

		function DockRow({ label, value, strong }) {
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "baseline",
						justifyContent: "space-between",
						gap: 8,
						fontSize: 11.5,
						lineHeight: "18px",
						color: mutedColor,
					},
				},
				h("span", null, label),
				h("span", { style: { color: strong ? textColor : "#c8d4ea", fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, value),
			);
		}

		/**
		 * Compact always-on dashboard docked in the window's lower-left corner,
		 * over the sidebar's empty tail: price band, this session's tokens, today's
		 * spend and the remaining balance. Clicking it opens the full panel.
		 */
		function PulseDock({ open }) {
			const [peak, setPeak] = useState(null);
			const [overview, setOverview] = useState(null);
			const [collapsed, setCollapsed] = useState(() => readStorage(DOCK_KEY, "0") === "1");
			const [drop, setDrop] = useState(null);
			const [, tick] = useState(0);

			useEffect(() => {
				let alive = true;
				async function loadPeak() {
					try {
						const response = await fetch("/pulse/api/peak", { headers: { accept: "application/json" } });
						if (response.ok && alive) setPeak(await response.json());
					} catch {
						/* retry on the next tick */
					}
				}
				async function loadOverview() {
					try {
						const response = await fetch("/pulse/api/overview?days=1", { headers: { accept: "application/json" } });
						if (!response.ok || !alive) return;
						const next = await response.json();
						setOverview(next);
						const event = maybeNotifyBalanceDrop(next.balance);
						if (event) setDrop(event);
					} catch {
						/* retry on the next tick */
					}
				}
				requestNotificationPermission();
				loadPeak();
				loadOverview();
				const peakTimer = window.setInterval(loadPeak, POLL_MS);
				const overviewTimer = window.setInterval(loadOverview, 60_000);
				const clock = window.setInterval(() => tick((value) => value + 1), 1000);
				return () => {
					alive = false;
					window.clearInterval(peakTimer);
					window.clearInterval(overviewTimer);
					window.clearInterval(clock);
				};
			}, []);

			// The drop banner is transient: keep it for 20s after a notification.
			useEffect(() => {
				if (!drop) return undefined;
				const timer = window.setTimeout(() => setDrop(null), 20_000);
				return () => window.clearTimeout(timer);
			}, [drop]);

			const now = Date.now();
			// The dock lives over the sidebar's empty tail; the rail has no room for it.
			let sidebarCollapsed = false;
			try {
				sidebarCollapsed = Boolean(document.querySelector("[data-sidebar-collapsed]"));
			} catch {
				sidebarCollapsed = false;
			}
			if (sidebarCollapsed) return null;
			const isPeak = peak ? peak.isPeak : null;
			const msLeft = peak && peak.nextChangeAt ? peak.nextChangeAt - now : null;
			const session = overview ? overview.currentSession : null;
			const today = overview && overview.daily && overview.daily.length ? overview.daily[overview.daily.length - 1] : null;
			const balance = overview ? overview.balance : null;
			const at = peak && peak.nextChangeAt ? clockText(peak.nextChangeAt, peak.timeZone) : "";

			const dot = h("span", {
				style: {
					width: 7,
					height: 7,
					borderRadius: "50%",
					background: isPeak ? peakColor : offColor,
					boxShadow: `0 0 8px ${isPeak ? peakColor : offColor}`,
					display: "inline-block",
					flex: "0 0 auto",
				},
			});

			const toggle = (event) => {
				event.stopPropagation();
				const next = !collapsed;
				setCollapsed(next);
				writeStorage(DOCK_KEY, next ? "1" : "0");
			};

			const wrap = {
				position: "fixed",
				left: 12,
				bottom: 72,
				zIndex: 70,
				width: collapsed ? "auto" : 232,
				fontFamily: "inherit",
				pointerEvents: "auto",
			};

			if (collapsed) {
				return h(
					"div",
					{ style: wrap },
					h(
						"button",
						{
							type: "button",
							onClick: toggle,
							title: "Mở Pulse",
							style: {
								display: "flex",
								alignItems: "center",
								gap: 7,
								padding: "6px 10px",
								borderRadius: 999,
								border: `1px solid ${lineColor}`,
								background: "rgba(13,21,36,0.92)",
								color: mutedColor,
								font: "inherit",
								fontSize: 11,
								cursor: "pointer",
								boxShadow: "0 10px 24px -16px rgba(0,0,0,0.9)",
							},
						},
						dot,
						session ? h("span", { style: { color: textColor, fontWeight: 600 } }, fmtTokens(session.totalTokens)) : "Pulse",
					),
				);
			}

			return h(
				"div",
				{ style: wrap, title: "Mở bảng đầy đủ", onClick: open, role: "button", tabIndex: 0 },
				h(
					"div",
					{
						style: {
							background: cardColor,
							border: `1px solid ${lineColor}`,
							borderRadius: 12,
							padding: "10px 12px 11px",
							boxShadow: "0 18px 40px -22px rgba(0,0,0,0.9)",
							cursor: "pointer",
							color: textColor,
						},
					},
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 7 } },
						dot,
						h(
							"span",
							{
								style: {
									fontSize: 10.5,
									fontWeight: 700,
									letterSpacing: "0.07em",
									color: isPeak ? peakColor : offColor,
								},
							},
							isPeak == null ? "PULSE" : isPeak ? "CAO ĐIỂM" : "THẤP ĐIỂM",
						),
						h(
							"button",
							{
								type: "button",
								onClick: toggle,
								title: "Thu gọn",
								style: {
									marginLeft: "auto",
									border: 0,
									background: "transparent",
									color: faintColor,
									font: "inherit",
									fontSize: 14,
									lineHeight: "14px",
									cursor: "pointer",
									padding: "0 2px",
								},
							},
							"–",
						),
					),
					h(
						"div",
						{ style: { fontSize: 10.5, color: faintColor, marginTop: 2, minHeight: 14 } },
						msLeft != null && msLeft > 0
							? `${peak.nextIsPeak ? "cao điểm" : "thấp điểm"} ${at} · còn ${fmtDuration(msLeft)}`
							: "",
					),
					h("div", { style: { height: 1, background: lineColor, margin: "8px 0 7px" } }),
					h(DockRow, { label: "Phiên này", value: fmtTokens(session && session.totalTokens), strong: true }),
					h(DockRow, { label: "Hôm nay", value: fmtMoney(today && today.cost), strong: true }),
					h(DockRow, { label: "Số dư", value: balance && balance.connected ? fmtMoney(balance.total, 2) : "—", strong: true }),
					drop
						? h(
								"div",
								{
									style: {
										marginTop: 8,
										padding: "4px 7px",
										borderRadius: 6,
										background: "rgba(245,165,36,0.12)",
										border: "1px solid rgba(245,165,36,0.35)",
										fontSize: 11,
										color: peakColor,
									},
								},
								`−$${drop.drop.toFixed(2)} · còn $${drop.total.toFixed(2)}`,
							)
						: null,
				),
			);
		}

		/**
		 * Client plugin body: one sidebar entry, one main panel, the peak alert and
		 * the corner dock.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const openPanel = () => {
				try {
					ctx.layout.selectPanel(PANEL_ID);
				} catch {
					/* layout unavailable: the sidebar entry still works */
				}
			};

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID }, PulsePanel),
			);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 6, label: () => "Pulse" },
					PulseIcon,
				),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "pulse.peak-alert" }, PeakAlert),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "pulse.dock", order: 30 }, () =>
					h(PulseDock, { open: openPanel }),
				),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "layout"];
		return module.exports;
	},
});
