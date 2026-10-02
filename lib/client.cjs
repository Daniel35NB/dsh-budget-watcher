// dsh-budget-watcher — client half.
//
// A classic script that registers a lazy-CJS factory with the web shell's module
// loader. The loader serves this file as `<package>/client.js` and appends it as
// a `<script>`; running it only registers the factory below, and the factory body
// executes at materialization. There is no bundler and no JSX: `require` accepts
// the shell's static module table (React among it), and elements are built with
// `React.createElement`.
//
// The widget mounts into `shell.overlay` — the frame-wide floating layer above
// every column and outside their scroll containers, which is exactly "a small
// window hovering over the conversation page". That layer is click-through and
// gives each direct child `pointer-events: auto`, so the panel is interactive
// without blocking the app underneath.

window.__ModuleLoader__.load({
  id: "dsh-budget-watcher",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    /** Route the host half registers, resolved against the app's own base URL. */
    var STATE_PATH = "dsh-budget-watcher/balance";

    /** Where the panel remembers that the user moved or collapsed it. */
    var POSITION_KEY = "dsh-budget-watcher:position";
    var COLLAPSED_KEY = "dsh-budget-watcher:collapsed";

    var CURRENCY_SYMBOLS = { CNY: "\u00a5", USD: "$", EUR: "\u20ac", JPY: "\u00a5", GBP: "\u00a3" };

    var CSS = [
      ".dshbw-panel{position:fixed;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;",
      "min-width:172px;max-width:min(300px,calc(100vw - 24px));padding:10px 12px;",
      "color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);",
      "border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);",
      "box-shadow:var(--dsw-elevation-panel);font-family:var(--dsw-font-family);font-size:12px;line-height:1.4;",
      "user-select:none;-webkit-user-select:none;cursor:grab}",
      ".dshbw-panel--dragging{cursor:grabbing}",
      ".dshbw-head{display:flex;align-items:center;gap:6px}",
      ".dshbw-title{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.02em;",
      "text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshbw-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}",
      ".dshbw-dot--ok{background:var(--dsw-alias-state-success-primary)}",
      ".dshbw-dot--warn{background:var(--dsw-alias-state-warn-primary)}",
      ".dshbw-dot--bad{background:var(--dsw-alias-state-error-primary)}",
      ".dshbw-amount{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dshbw-amount--muted{color:var(--dsw-alias-label-tertiary);font-size:15px;font-weight:500}",
      ".dshbw-caption{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".dshbw-sep{height:.5px;margin:3px 0 1px;background:var(--dsw-alias-border-l1)}",
      ".dshbw-cost{display:flex;flex-direction:column;gap:2px;font-size:11px;font-variant-numeric:tabular-nums}",
      ".dshbw-cost-row{display:flex;gap:6px;align-items:baseline;color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-cost-key{flex:0 0 auto}",
      ".dshbw-cost-value{color:var(--dsw-alias-label-primary);font-weight:500}",
      ".dshbw-burn{color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-burn--warn{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
      ".dshbw-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}",
      ".dshbw-error{color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-word}",
      ".dshbw-actions{display:flex;align-items:center;gap:6px;margin-top:1px}",
      ".dshbw-spacer{flex:1 1 auto}",
      ".dshbw-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);",
      "font:inherit;font-size:11px;padding:2px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer}",
      ".dshbw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dshbw-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dshbw-btn[disabled]{opacity:.5;cursor:default}",
      // Settings tab.
      ".dshbw-form{display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".dshbw-group{display:flex;flex-direction:column;gap:8px;padding-top:9px;border-top:.5px solid var(--dsw-alias-border-l1)}",
      ".dshbw-group-title{color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.04em;text-transform:uppercase}",
      ".dshbw-field{display:flex;flex-direction:column;gap:3px}",
      ".dshbw-label{color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".dshbw-input{box-sizing:border-box;width:100%;padding:4px 8px;color:var(--dsw-alias-label-primary);",
      "background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);",
      "border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px}",
      ".dshbw-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dshbw-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dshbw-actions-row{display:flex;align-items:center;gap:8px;padding-top:2px}",
      ".dshbw-save{appearance:none;border:0;padding:5px 12px;border-radius:var(--dsw-radius-sm);",
      "background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);",
      "font:inherit;font-size:12px;cursor:pointer}",
      ".dshbw-save[disabled]{opacity:.5;cursor:default}",
      ".dshbw-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-note--ok{color:var(--dsw-alias-state-success-primary)}",
      ".dshbw-note--bad{color:var(--dsw-alias-state-error-primary)}",
      ".dshbw-pill{position:fixed;z-index:30;display:flex;align-items:center;gap:6px;box-sizing:border-box;",
      "padding:5px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);",
      "border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;box-shadow:var(--dsw-elevation-panel);",
      "font-family:var(--dsw-font-family);font-size:12px;font-variant-numeric:tabular-nums;",
      "user-select:none;-webkit-user-select:none}",
      ".dshbw-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshbw-pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
    ].join("");

    /** One `<style>` tag owned by this plugin id, so the loader removes it on unload. */
    function installStyles() {
      var tagId = "dsh-budget-watcher/panel.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-budget-watcher";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * The headline figure is `total` — topped-up money plus granted credit —
     * because that is the whole balance. Showing only the topped-up part would
     * read as zero on an account living on granted credit, and the panel has no
     * room for a second line to explain that.
     */
    function formatAmount(wallet) {
      if (wallet === null || wallet === undefined) return "\u2014";
      var symbol = CURRENCY_SYMBOLS[wallet.currency] ?? "";
      return symbol + wallet.total + " " + wallet.currency;
    }

    /**
     * A cost estimate. Always prefixed with "≈": these are published rates
     * applied to recorded token counts, converted at the user's own exchange
     * rate, and presenting that as an exact figure would overstate it.
     */
    function formatCost(amount, currency) {
      if (typeof amount !== "number" || !isFinite(amount)) return "\u2014";
      var symbol = CURRENCY_SYMBOLS[currency] ?? "";
      var suffix = CURRENCY_SYMBOLS[currency] === undefined ? " " + currency : "";
      if (amount > 0 && amount < 0.005) return "\u2248" + symbol + "<0.01" + suffix;
      return "\u2248" + symbol + amount.toFixed(2) + suffix;
    }

    /** "just now" / "3 min ago" — enough to judge whether a number is current. */
    function relativeTime(at) {
      if (typeof at !== "number") return "never";
      var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 45) return "just now";
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + " min ago";
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + " h ago";
      return Math.round(hours / 24) + " d ago";
    }

    function readStored(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        // Private mode and some embedded webviews refuse storage. Position and
        // collapse state are conveniences, so losing them is not an error.
        return null;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* see readStored */
      }
    }

    function loadPosition() {
      var raw = readStored(POSITION_KEY);
      if (raw === null) return null;
      try {
        var parsed = JSON.parse(raw);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") return parsed;
      } catch {
        /* fall through to the default corner */
      }
      return null;
    }

    /**
     * The floating window.
     *
     * State comes from the host route, which owns the credential, the upstream
     * request and the cache. This component only decides what to draw: a poll
     * every `refreshIntervalMs`, one forced refresh on demand, and drag /
     * collapse state that survives a page reload.
     */
    function BudgetWatcher(props) {
      // A root-scoped slot entry receives the frame's standard kit as props, so
      // `useSessions` is the supported way in. The selector is the same one
      // DSH's own title bar uses: the session the Conversation retains. It
      // returns a string, not an object, so it is stable across renders and
      // needs no equality function.
      //
      // The feature test is fixed for the life of this entry, so calling the
      // hook behind it keeps a constant hook order.
      var useSessions = props !== null && props !== undefined ? props.useSessions : undefined;
      var selectedSessionId;
      if (typeof useSessions === "function") {
        selectedSessionId = useSessions(function (state) {
          var rows = state !== null && state !== undefined ? state.byId : null;
          if (rows === null || rows === undefined) return undefined;
          for (var key in rows) {
            var row = rows[key];
            if (row !== null && row !== undefined && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row.id;
          }
          return undefined;
        });
      }

      var statePair = React.useState({ status: "loading", data: null, error: null });
      var view = statePair[0];
      var setView = statePair[1];

      var refreshingPair = React.useState(false);
      var refreshing = refreshingPair[0];
      var setRefreshing = refreshingPair[1];

      var collapsedPair = React.useState(function () {
        return readStored(COLLAPSED_KEY) === "1";
      });
      var collapsed = collapsedPair[0];
      var setCollapsed = collapsedPair[1];

      var positionPair = React.useState(loadPosition);
      var position = positionPair[0];
      var setPosition = positionPair[1];

      var dragPair = React.useState(null);
      var drag = dragPair[0];
      var setDrag = dragPair[1];

      var rootRef = React.useRef(null);
      var pollRef = React.useRef(null);

      // Reads the host route. `force` asks the host to ignore its freshness
      // window, which is what the refresh button does. Naming the session lets
      // the host price the conversation actually on screen instead of guessing
      // at the busiest one.
      var load = React.useCallback(function (force) {
        var url = new URL(STATE_PATH, document.baseURI);
        if (force === true) url.searchParams.set("refresh", "1");
        if (typeof selectedSessionId === "string" && selectedSessionId !== "") {
          url.searchParams.set("session", selectedSessionId);
        }
        return fetch(url.href, { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) {
            setView({ status: "ready", data: data, error: null });
          })
          .catch(function (error) {
            // A failed poll must not erase the last balance: the previous
            // number with its timestamp is still the most useful thing on
            // screen, and the host reports its own upstream failure in the
            // body when it can.
            setView(function (previous) {
              return { status: previous.data === null ? "error" : "ready", data: previous.data, error: String((error && error.message) || error) };
            });
          });
      }, [selectedSessionId]);

      // Poll on the cadence the host reports, so one config change moves every
      // open window. `setInterval` is cleaned up here rather than through
      // `ctx.timer` because the component's own lifetime is the correct scope:
      // collapsing the pill must stop the timer even though the fiber lives on.
      var intervalMs = view.data === null ? 60000 : (view.data.refreshIntervalMs || 60000);
      React.useEffect(
        function () {
          load(false);
          pollRef.current = window.setInterval(function () {
            load(false);
          }, intervalMs);
          return function () {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
          };
        },
        [load, intervalMs],
      );

      // Drag from anywhere on the expanded panel. Pointer capture keeps the
      // panel under the cursor when the pointer leaves the element, and the
      // move is written back to storage only on release so a drag does not
      // thrash localStorage. Clicks that land on a control are left alone, so
      // the collapse and refresh buttons still work while the panel is
      // draggable everywhere. The collapsed pill deliberately installs none of
      // this: it stays put and behaves as a single button.
      var onPointerDown = React.useCallback(
        function (event) {
          if (event.button !== 0) return;
          if (event.target.closest("button") !== null) return;
          var rect = rootRef.current?.getBoundingClientRect();
          if (rect === undefined || rect === null) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top });
        },
        [],
      );

      var onPointerMove = React.useCallback(
        function (event) {
          if (drag === null) return;
          var width = rootRef.current?.offsetWidth ?? 0;
          var height = rootRef.current?.offsetHeight ?? 0;
          var x = Math.min(Math.max(0, event.clientX - drag.dx), Math.max(0, window.innerWidth - width));
          var y = Math.min(Math.max(0, event.clientY - drag.dy), Math.max(0, window.innerHeight - height));
          setPosition({ x: x, y: y });
        },
        [drag],
      );

      var onPointerUp = React.useCallback(
        function (event) {
          if (drag === null) return;
          setDrag(null);
          var target = event.currentTarget;
          if (target.hasPointerCapture?.(event.pointerId) === true) target.releasePointerCapture(event.pointerId);
          setPosition(function (current) {
            if (current !== null) writeStored(POSITION_KEY, JSON.stringify(current));
            return current;
          });
        },
        [drag],
      );

      var toggleCollapsed = React.useCallback(function () {
        setCollapsed(function (previous) {
          writeStored(COLLAPSED_KEY, previous ? "0" : "1");
          return !previous;
        });
      }, []);

      var onRefresh = React.useCallback(
        function () {
          setRefreshing(true);
          load(true).then(
            function () {
              setRefreshing(false);
            },
            function () {
              setRefreshing(false);
            },
          );
        },
        [load],
      );

      var data = view.data;
      // The host keeps the last good answer and marks it stale, so a transport
      // failure and an upstream failure render differently.
      var transportError = view.error !== null && data === null;
      var hostError = data !== null && data.error !== null;
      var stale = data !== null && data.stale === true;

      var dotClass = "dshbw-dot";
      if (transportError || (hostError && data?.featured == null)) dotClass += " dshbw-dot--bad";
      // A burning session turns the dot amber, which is the one signal that
      // survives collapsing the panel to a pill.
      else if (hostError || stale || data?.isAvailable === false || data?.cost?.warn === true) dotClass += " dshbw-dot--warn";
      else if (data !== null) dotClass += " dshbw-dot--ok";

      var amountText = hostError && data?.featured == null ? "\u2014" : formatAmount(data?.featured ?? null);

      var style = position === null ? { right: 16, bottom: 16 } : { left: position.x, top: position.y };

      if (collapsed) {
        return React.createElement(
          "div",
          {
            className: "dshbw-pill",
            style: style,
            role: "button",
            tabIndex: 0,
            title: amountText + " \u2014 click to expand",
            "aria-label": "Budget watcher: " + amountText + ". Click to expand.",
            onClick: function () {
              toggleCollapsed();
            },
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleCollapsed();
              }
            },
          },
          React.createElement("span", { className: dotClass }),
          React.createElement("span", null, amountText),
        );
      }

      var children = [
        React.createElement(
          "div",
          {
            className: "dshbw-head",
            key: "head",
            onDoubleClick: toggleCollapsed,
            title: "Double-click to collapse",
          },
          React.createElement("span", { className: dotClass }),
          React.createElement("span", { className: "dshbw-title" }, (data?.provider?.label ?? "DeepSeek") + " balance"),
          // Offered only when a tab was actually registered, so the control
          // never appears on a profile where it could not do anything.
          openSettingsTab !== null
            ? React.createElement(
                "button",
                {
                  className: "dshbw-btn",
                  type: "button",
                  onClick: function () {
                    if (selectedSessionId === undefined) return;
                    openSettingsTab(selectedSessionId);
                  },
                  title: "Open settings",
                  "aria-label": "Open budget watcher settings",
                },
                "\u2699\ufe0e",
              )
            : null,
          React.createElement(
            "button",
            {
              className: "dshbw-btn",
              type: "button",
              onClick: toggleCollapsed,
              title: "Collapse to a pill",
              "aria-label": "Collapse budget watcher",
            },
            "\u2013",
          ),
        ),
        React.createElement(
          "div",
          { className: "dshbw-amount" + (hostError && data?.featured == null ? " dshbw-amount--muted" : ""), key: "amount" },
          amountText,
        ),
      ];

      // No caption and no second line under the amount: the header already
      // names what the figure is, and the figure is the whole balance. The
      // granted/topped-up split is available in the settings tab for anyone who
      // wants it, which keeps the panel itself down to three rows.

      // Cost estimates. Deliberately placed under the balance and before the
      // error rows: the whole point of this section is the fan-out case, where
      // one visible turn has spawned dozens of billed subagent sessions, so the
      // session total and the projected hourly burn carry more signal than the
      // last turn does.
      var cost = data?.cost ?? null;
      if (cost !== null && cost.available === true) {
        var costRows = [];

        if (cost.lastTurn !== null && cost.lastTurn !== undefined) {
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "last" },
              React.createElement("span", { className: "dshbw-cost-key" }, "last turn"),
              React.createElement("span", { className: "dshbw-cost-value" }, formatCost(cost.lastTurn.amount, cost.currency)),
            ),
          );
        }

        var sessionParts = ["session " + formatCost(cost.session.amount, cost.currency)];
        if (cost.session.turns > 0) {
          sessionParts.push(cost.session.turns + (cost.session.turns === 1 ? " turn" : " turns"));
        }
        if (cost.session.descendants > 0) {
          sessionParts.push(cost.session.descendants + " agents");
        }
        costRows.push(
          React.createElement("div", { className: "dshbw-cost-row", key: "session" },
            React.createElement("span", null, sessionParts.join(" \u00b7 "))),
        );

        if (cost.recent.messages > 0) {
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "burn" },
              React.createElement(
                "span",
                { className: "dshbw-burn" + (cost.warn === true ? " dshbw-burn--warn" : "") },
                "burn " + formatCost(cost.recent.amountPerHour, cost.currency) + "/h",
              ),
            ),
          );
        }

        // A model with no published rate is reported rather than costed at a
        // guess; silence would look like "this turn was free".
        if (cost.session.unpricedTurns > 0) {
          costRows.push(
            React.createElement("div", { className: "dshbw-cost-row", key: "unpriced" },
              React.createElement("span", { className: "dshbw-burn" },
                cost.session.unpricedTurns + " turn(s) unpriced")),
          );
        }

        children.push(React.createElement("div", { className: "dshbw-sep", key: "cost-sep" }));
        children.push(React.createElement("div", { className: "dshbw-cost", key: "cost" }, costRows));
      }

      if (data !== null && data.isAvailable === false) {
        children.push(
          React.createElement("div", { className: "dshbw-warn", key: "unavailable" }, "Not available for API calls"),
        );
      }
      if (hostError) {
        children.push(
          React.createElement(
            "div",
            { className: "dshbw-error", key: "host-error" },
            (stale ? "Last check failed: " : "") + data.error.message,
          ),
        );
      } else if (transportError) {
        children.push(
          React.createElement("div", { className: "dshbw-error", key: "transport-error" }, "Cannot reach dsh: " + view.error),
        );
      }

      children.push(
        React.createElement(
          "div",
          { className: "dshbw-actions", key: "actions" },
          React.createElement("span", { className: "dshbw-caption" }, relativeTime(data?.fetchedAt ?? null)),
          React.createElement("span", { className: "dshbw-spacer" }),
          React.createElement(
            "button",
            {
              className: "dshbw-btn",
              type: "button",
              disabled: refreshing,
              onClick: onRefresh,
              title: "Check now",
              "aria-label": "Refresh balance now",
            },
            refreshing ? "checking\u2026" : "refresh",
          ),
        ),
      );

      return React.createElement(
        "div",
        {
          className: "dshbw-panel" + (drag !== null ? " dshbw-panel--dragging" : ""),
          style: style,
          ref: rootRef,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        },
        children,
      );
    }

    // --- settings tab ------------------------------------------------------

    /** The plugin's write route. Same origin, JSON body required by the fence. */
    var CONFIG_PATH = "dsh-budget-watcher/config";

    /**
     * Right-sidebar tab identity. `sidebarRight.openTabIn` takes a tab *kind*,
     * and the body and title are keyed slots dispatched by the tab id, which is
     * why this is one stable string used in four places.
     */
    var TAB_KIND = "budget-watcher-settings";
    var TAB_ID = "dsh-budget-watcher/settings";
    var TAB_TITLE = "Budget";
    var TAB_BODY_SLOT = "sidebar.right.pane.tab";
    var TAB_TITLE_SLOT = "sidebar.right.pane.tab.title";

    /**
     * Opens the settings tab for a session, once something has registered one.
     * `null` when this profile has no right sidebar, which is what hides the
     * gear button rather than offering a control that does nothing.
     */
    var openSettingsTab = null;

    /** Milliseconds to a form field the user types in, and back. */
    var msToSeconds = function (ms) { return String(Math.round(ms / 1000)); };
    var secondsToMs = function (text) { return Math.round(Number(text) * 1000); };
    var msToMinutes = function (ms) { return String(Math.round(ms / 60000)); };
    var minutesToMs = function (text) { return Math.round(Number(text) * 60000); };

    function field(label, value, onChange, options) {
      var settings = options ?? {};
      return React.createElement(
        "label",
        { className: "dshbw-field", key: settings.key ?? label },
        React.createElement("span", { className: "dshbw-label" }, label),
        React.createElement("input", {
          className: "dshbw-input",
          type: settings.type ?? "text",
          value: value,
          placeholder: settings.placeholder,
          autoComplete: settings.type === "password" ? "new-password" : undefined,
          onChange: function (event) { onChange(event.target.value); },
        }),
      );
    }

    function checkbox(label, checked, onChange, key) {
      return React.createElement(
        "label",
        { className: "dshbw-check", key: key },
        React.createElement("input", {
          type: "checkbox",
          checked: checked === true,
          onChange: function (event) { onChange(event.target.checked); },
        }),
        React.createElement("span", null, label),
      );
    }

    /**
     * The settings surface.
     *
     * It fetches the running configuration itself rather than sharing the
     * panel's poll: the two have different lifetimes, and a settings form that
     * repainted on every balance poll would fight whoever is typing in it.
     *
     * Nothing here is applied locally. Saving posts to the host, which writes
     * the profile patch through the loader's own config editor, so what the form
     * shows afterwards is the value the plugin is actually running with — not
     * what the form hoped it would be.
     */
    function SettingsTab() {
      var statePair = React.useState({ status: "loading", settings: null, error: null });
      var view = statePair[0];
      var setView = statePair[1];
      var formPair = React.useState(null);
      var form = formPair[0];
      var setForm = formPair[1];
      var savePair = React.useState({ status: "idle", text: "" });
      var save = savePair[0];
      var setSave = savePair[1];
      var keyTouchedPair = React.useState(false);
      var keyTouched = keyTouchedPair[0];
      var setKeyTouched = keyTouchedPair[1];

      var adopt = React.useCallback(function (next) {
        if (next === null || next === undefined || next.effective === undefined) return;
        var e = next.effective;
        setForm({
          provider: e.provider,
          apiKeyEnv: e.apiKeyEnv,
          endpoint: e.endpoint ?? "",
          apiKey: "",
          currency: e.currency,
          refreshSeconds: msToSeconds(e.refreshIntervalMs),
          timeoutSeconds: msToSeconds(e.requestTimeoutMs),
          costCurrency: e.costCurrency,
          costEnabled: e.costEnabled,
          burnMinutes: msToMinutes(e.burnWindowMs),
          warnUsd: String(e.burnWarnUsdPerHour),
          usdToCny: String(e.usdToCny),
          allowNonLoopback: e.allowNonLoopback,
        });
      }, []);

      var load = React.useCallback(function () {
        return fetch(new URL(STATE_PATH, document.baseURI).href, { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) {
            setView({ status: "ready", settings: data.settings ?? null, error: null });
            adopt(data.settings);
          })
          .catch(function (error) {
            setView({ status: "error", settings: null, error: String((error && error.message) || error) });
          });
      }, [adopt]);

      React.useEffect(function () { load(); }, [load]);

      var update = React.useCallback(function (key, value) {
        setForm(function (previous) { return Object.assign({}, previous, { [key]: value }); });
        setSave({ status: "idle", text: "" });
      }, []);

      var onSave = React.useCallback(function () {
        if (form === null) return;
        var patch = {
          provider: form.provider,
          apiKeyEnv: form.apiKeyEnv,
          endpoint: form.endpoint,
          currency: form.currency,
          costCurrency: form.costCurrency,
          costEnabled: form.costEnabled,
          allowNonLoopback: form.allowNonLoopback,
          refreshIntervalMs: secondsToMs(form.refreshSeconds),
          requestTimeoutMs: secondsToMs(form.timeoutSeconds),
          burnWindowMs: minutesToMs(form.burnMinutes),
          burnWarnUsdPerHour: Number(form.warnUsd),
          usdToCny: Number(form.usdToCny),
        };
        for (var name in patch) {
          if (typeof patch[name] === "number" && !isFinite(patch[name])) {
            setSave({ status: "error", text: name + " must be a number" });
            return;
          }
        }
        // Only sent when the field was actually touched: an untouched password
        // box posts nothing, and an emptied one clears the key.
        if (keyTouched) patch.apiKey = form.apiKey;

        setSave({ status: "saving", text: "saving\u2026" });
        fetch(new URL(CONFIG_PATH, document.baseURI).href, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ patch: patch }),
        })
          .then(function (response) {
            return response.json().then(function (body) { return { ok: response.ok, body: body }; });
          })
          .then(function (result) {
            if (result.body?.settings !== undefined) {
              setView({ status: "ready", settings: result.body.settings, error: null });
              adopt(result.body.settings);
            }
            setKeyTouched(false);
            if (result.ok && result.body?.ok === true) {
              setSave({ status: "saved", text: result.body.note ?? "Saved." });
            } else {
              setSave({ status: "error", text: result.body?.error ?? "Save failed." });
            }
          })
          .catch(function (error) {
            setSave({ status: "error", text: String((error && error.message) || error) });
          });
      }, [form, keyTouched, adopt]);

      if (view.status === "loading") {
        return React.createElement("div", { className: "dshbw-form dshbw-note" }, "Loading settings\u2026");
      }
      if (view.status === "error") {
        return React.createElement("div", { className: "dshbw-form dshbw-note dshbw-note--bad" }, "Cannot read settings: " + view.error);
      }
      if (form === null) {
        return React.createElement("div", { className: "dshbw-form dshbw-note" }, "No settings reported by the host.");
      }

      var editable = view.settings !== null && view.settings.editable === true;
      var children = [];

      if (!editable) {
        children.push(
          React.createElement("div", { className: "dshbw-note dshbw-note--bad", key: "ro" },
            "Read-only: " + ((view.settings && view.settings.reason) ?? "unknown") +
            ". Edit the profile patch by hand; save the values below for reference."),
        );
      }

      children.push(
        React.createElement("div", { className: "dshbw-group-title", key: "g-bal" }, "Balance"),
        field("API key reference", form.apiKeyEnv, function (v) { update("apiKeyEnv", v); }, { key: "apiKeyEnv" }),
        field("API key", form.apiKey, function (v) { setKeyTouched(true); update("apiKey", v); }, {
          key: "apiKey",
          type: "password",
          placeholder: view.settings?.apiKeySet === true ? "\u2022\u2022\u2022\u2022 set \u2014 type to replace, clear to remove" : "not set",
        }),
        field("Currency (auto, CNY, USD)", form.currency, function (v) { update("currency", v); }, { key: "currency" }),
        field("Advanced: balance endpoint", form.endpoint, function (v) { update("endpoint", v); }, {
          key: "endpoint",
          placeholder: "provider default",
        }),
      );

      children.push(
        React.createElement("div", { className: "dshbw-group", key: "g-cost" },
          React.createElement("div", { className: "dshbw-group-title" }, "Cost estimate"),
          checkbox("Estimate what turns cost", form.costEnabled, function (v) { update("costEnabled", v); }, "costEnabled"),
          field("Burn window (minutes)", form.burnMinutes, function (v) { update("burnMinutes", v); }, { key: "burnMinutes", type: "number" }),
          field("Warn above (USD/hour)", form.warnUsd, function (v) { update("warnUsd", v); }, { key: "warnUsd", type: "number" }),
          field("USD \u2192 CNY rate", form.usdToCny, function (v) { update("usdToCny", v); }, { key: "usdToCny", type: "number" }),
          field("Cost currency (auto, CNY, USD)", form.costCurrency, function (v) { update("costCurrency", v); }, { key: "costCurrency" }),
        ),
      );

      children.push(
        React.createElement("div", { className: "dshbw-group", key: "g-adv" },
          React.createElement("div", { className: "dshbw-group-title" }, "Polling"),
          field("Refresh interval (seconds)", form.refreshSeconds, function (v) { update("refreshSeconds", v); }, { key: "refreshSeconds", type: "number" }),
          field("Request timeout (seconds)", form.timeoutSeconds, function (v) { update("timeoutSeconds", v); }, { key: "timeoutSeconds", type: "number" }),
          field("Provider", form.provider, function (v) { update("provider", v); }, { key: "provider" }),
          checkbox("Allow the route on a non-loopback address", form.allowNonLoopback, function (v) { update("allowNonLoopback", v); }, "allowNonLoopback"),
        ),
      );

      children.push(
        React.createElement("div", { className: "dshbw-actions-row", key: "actions" },
          React.createElement("button", {
            className: "dshbw-save",
            type: "button",
            disabled: !editable || save.status === "saving",
            onClick: onSave,
          }, save.status === "saving" ? "Saving\u2026" : "Save"),
          React.createElement("span", {
            className: "dshbw-note" + (save.status === "error" ? " dshbw-note--bad" : save.status === "saved" ? " dshbw-note--ok" : ""),
          }, save.text),
        ),
      );

      return React.createElement("div", { className: "dshbw-form" }, children);
    }

    /**
     * Register the tab, then hand back an opener for the gear button.
     *
     * Everything is wrapped: these are optional services, and a profile without
     * a right sidebar should lose the button, not the panel.
     */
    function registerSettingsTab(host) {
      var disposers = [];
      var dispose = function () {
        openSettingsTab = null;
        for (var index = disposers.length - 1; index >= 0; index -= 1) {
          try { disposers[index](); } catch { /* already gone */ }
        }
        disposers.length = 0;
      };
      try {
        var sidebar = host.get("sidebarRight");
        var tabs = host.get("sidebarRightTabs");
        if (typeof sidebar?.openTabIn !== "function" || typeof tabs?.register !== "function") return function () {};

        disposers.push(host.slots.register({ name: TAB_BODY_SLOT, key: TAB_ID }, SettingsTab));
        disposers.push(host.slots.register({ name: TAB_TITLE_SLOT, key: TAB_ID }, function () {
          return React.createElement("span", null, TAB_TITLE);
        }));
        disposers.push(tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: function () { return TAB_TITLE; },
          guide: [{
            order: 70,
            title: function () { return TAB_TITLE; },
            description: function () { return "Balance, cost estimate and polling settings."; },
          }],
        }));
        openSettingsTab = function (sessionId) {
          try {
            sidebar.openTabIn(sessionId, TAB_KIND);
            return true;
          } catch {
            return false;
          }
        };
      } catch {
        dispose();
        return function () {};
      }
      return dispose;
    }

    // The `slots` service is the only hard dependency: it is always present
    // wherever `shell.overlay` is, and a service declared here that the profile
    // does not provide would leave this fiber pending. Timers are owned by the
    // component instead (see `BudgetWatcher`), and the settings tab registers
    // only when the right sidebar is actually there.
    var inject = ["slots"];

    function apply(ctx) {
      installStyles();

      if (ctx.get("sidebarRight") !== undefined && ctx.get("sidebarRightTabs") !== undefined) {
        ctx.inject(["sidebarRight", "sidebarRightTabs"], function (injected) {
          return registerSettingsTab(injected);
        });
      }

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "budget-watcher",
            order: 50,
            label: "Budget watcher",
          },
          BudgetWatcher,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
