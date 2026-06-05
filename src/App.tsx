/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';

const RADIAL_GRID_STYLE = {
  backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)',
  backgroundSize: '32px 32px',
};
const BUTTON_HOVER = { scale: 1.02 };
const BUTTON_TAP = { scale: 0.95 };
const COUNT_INITIAL = { scale: 1.5, color: '#86efac' };
const COUNT_ANIMATE = { scale: 1, color: '#ffffff' };
const COUNT_TRANSITION = { duration: 0.25, ease: 'easeOut' };
const IDLE_REST = { opacity: 1 };
const IDLE_PULSE = { opacity: [1, 0.85, 1] };
const IDLE_REST_TRANSITION = { duration: 0.4, ease: 'easeOut' };
const IDLE_PULSE_TRANSITION = { duration: 2, repeat: Infinity, ease: 'easeInOut' };
const STORAGE_KEY = 'homebase:clicks';
const IDLE_DELAY_MS = 10000;

// Fallback used when /api/health is unreachable so the banner still tells the operator something.
const BUILDING_FALLBACK = {
  label: 'Tier 1 — server + health + tests',
  branch: 'alpha',
  base: 'main',
  pr_number: 1,
  pr_url: 'https://github.com/atomeam/HomeBase-/pull/1',
  repo_url: 'https://github.com/atomeam/HomeBase-',
};

type Building = typeof BUILDING_FALLBACK;

type HealthResponse = {
  status: string;
  service: string;
  version: string;
  git_sha: string;
  bridge: { configured: boolean };
  gemini: { configured: boolean; model: string };
  building?: Building;
};

type LogEntry = {
  ts?: string;
  step?: string;
  status?: string;
  proposal_id?: string;
  message?: string;
  [key: string]: any;
};

type LogsResponse = {
  entries: LogEntry[];
  total: number;
  error?: string;
};

// Bridge health response type (from /api/bridge/health)
type BridgeHealthResponse = {
  ok: boolean;
  version?: string;
  timestamp?: string;
  checks?: {
    env: { ok: boolean; detail: string; latencyMs: number };
    notion: { ok: boolean; detail: string; latencyMs: number };
    ollama: { ok: boolean; detail: string; latencyMs: number };
    gemini: { ok: boolean; detail: string; latencyMs: number };
  };
  telemetry?: {
    historyLength: number;
    isFlapping: boolean;
    firstFailureTime: string | null;
    lastSuccessTime: string | null;
  };
};

const ALPHA_SCRIPTS = [
  { id: 'observer', label: 'Observer', icon: '👁️' },
  { id: 'evaluator', label: 'Evaluator', icon: '📊' },
  { id: 'proposer', label: 'Proposer', icon: '💡' },
  { id: 'curator', label: 'Curator', icon: '🔐' },
  { id: 'applier', label: 'Applier', icon: '⚙️' },
  { id: 'reflector', label: 'Reflector', icon: '🪞' },
];

export default function App() {
  const [clicks, setClicks] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const n = saved ? Number(saved) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  const [isIdle, setIsIdle] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [runningScript, setRunningScript] = useState<string | null>(null);
  const [showActivityFeed, setShowActivityFeed] = useState(true);
  
  // Bridge health state
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealthResponse | null>(null);
  const [bridgeHealthError, setBridgeHealthError] = useState(false);
  const [bridgeHealthLastChecked, setBridgeHealthLastChecked] = useState<string | null>(null);
  const [prevBridgeOk, setPrevBridgeOk] = useState<boolean | null>(null);
  const [showAlert, setShowAlert] = useState(false);
  
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, String(clicks));
    }
  }, [clicks]);

  // Poll /api/health. Real footer + banner replace the previous hardcoded strings.
  useEffect(() => {
    let cancelled = false;
    const fetchHealth = () => {
      fetch('/api/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((j: HealthResponse) => {
          if (cancelled) return;
          setHealth(j);
          setHealthError(false);
        })
        .catch(() => {
          if (cancelled) return;
          setHealth(null);
          setHealthError(true);
        });
    };
    fetchHealth();
    const t = window.setInterval(fetchHealth, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Poll /api/bridge/health every 15 seconds
  useEffect(() => {
    let cancelled = false;
    const fetchBridgeHealth = () => {
      fetch('/api/bridge/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((j: BridgeHealthResponse) => {
          if (cancelled) return;
          
          // Check for status transition: ok:true -> ok:false
          if (prevBridgeOk === true && j.ok === false) {
            setShowAlert(true);
          }
          setPrevBridgeOk(j.ok);
          
          setBridgeHealth(j);
          setBridgeHealthError(false);
          // Parse timestamp for display
          if (j.timestamp) {
            const d = new Date(j.timestamp);
            setBridgeHealthLastChecked(d.toLocaleTimeString());
          }
        })
        .catch((err) => {
          if (cancelled) return;
          // Check for status transition on error
          if (prevBridgeOk === true) {
            setShowAlert(true);
          }
          setPrevBridgeOk(false);
          setBridgeHealth(null);
          setBridgeHealthError(true);
        });
    };
    fetchBridgeHealth();
    const t = window.setInterval(fetchBridgeHealth, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [prevBridgeOk]);

  // Manual bridge health refresh
  useEffect(() => {
    let cancelled = false;
    const fetchLogs = () => {
      fetch('/api/logs')
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((j: LogsResponse) => {
          if (cancelled) return;
          setLogs(j.entries || []);
          setLogsError(j.error || null);
        })
        .catch((err) => {
          if (cancelled) return;
          setLogsError(String(err));
        });
    };
    fetchLogs();
    const t = window.setInterval(fetchLogs, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const armIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setIsIdle(false);
    idleTimerRef.current = setTimeout(() => setIsIdle(true), IDLE_DELAY_MS);
  };

  useEffect(() => {
    armIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      buttonRef.current?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleClick = () => {
    setClicks(prev => prev + 1);
    armIdleTimer();
  };

  const handleReset = () => {
    setClicks(0);
    armIdleTimer();
  };

  const handleRunScript = async (scriptId: string) => {
    if (runningScript) return;
    setRunningScript(scriptId);
    try {
      const response = await fetch(`/api/run/${scriptId}`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      console.log(`[homebase] ${scriptId} completed:`, result);
    } catch (err) {
      console.error(`[homebase] ${scriptId} failed:`, err);
    } finally {
      setRunningScript(null);
    }
  };

  // Manual refresh for bridge health
  const handleRefreshBridge = async () => {
    try {
      const r = await fetch('/api/bridge/health');
      if (r.ok) {
        const j: BridgeHealthResponse = await r.json();
        setBridgeHealth(j);
        setBridgeHealthError(false);
        if (j.timestamp) {
          const d = new Date(j.timestamp);
          setBridgeHealthLastChecked(d.toLocaleTimeString());
        }
      }
    } catch (err) {
      setBridgeHealthError(true);
    }
  };

  const bridgeOk = health?.status === 'ok';
  const dotColor = bridgeOk
    ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
    : healthError
    ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'
    : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]';
  const versionLabel = health?.version ? `v${health.version}` : 'v0.1.0';
  const shaLabel = health?.git_sha ?? (healthError ? 'offline' : '…');
  const bridgeText = bridgeOk
    ? `Bridge Connection: Active · ${shaLabel}`
    : healthError
    ? 'Bridge Connection: Offline'
    : 'Bridge Connection: Probing…';

  const building: Building = health?.building ?? BUILDING_FALLBACK;

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col font-sans overflow-hidden border border-zinc-800 relative selection:bg-zinc-700">
      {/* Ambient Background Accents */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden select-none">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-blue-900/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-zinc-800/10 rounded-full blur-[120px]"></div>
        <div className="absolute inset-0 opacity-[0.03]" style={RADIAL_GRID_STYLE}></div>
      </div>

      {/* TOP BUILDING BANNER */}
      <div
        id="building-banner"
        className="relative z-30 border-b border-zinc-800 bg-[#0a0a0a]/95 backdrop-blur-sm px-6 sm:px-10 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-amber-400 text-base leading-none" aria-hidden="true">
            🔁
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.4em] text-zinc-500 shrink-0">
            Building
          </span>
          <a
            href={building.pr_url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] tracking-wider text-zinc-200 hover:text-white truncate underline decoration-zinc-700 hover:decoration-white underline-offset-4"
            title={`Open PR #${building.pr_number}`}
          >
            {building.branch} → {building.base} · PR #{building.pr_number}
          </a>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] tracking-wider text-zinc-500 truncate max-w-[60ch]">
            {building.label}
          </span>
          <a
            href={building.repo_url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] tracking-wider text-zinc-500 hover:text-zinc-200 whitespace-nowrap"
          >
            repo ↗
          </a>
        </div>
      </div>

      {/* Alert Banner - shows when status flips from ok:true to ok:false */}
      {showAlert && (
        <div className="relative z-30 bg-red-900/90 border-b border-red-700 px-6 py-2 flex items-center justify-center gap-3">
          <span className="text-red-400 text-sm">⚠️</span>
          <span className="font-mono text-xs text-red-200">
            Bridge Health Alert: Status changed to FAILED
          </span>
          <button
            onClick={() => setShowAlert(false)}
            className="font-mono text-[10px] px-2 py-1 bg-red-800 hover:bg-red-700 text-red-300 rounded"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Layout: Command Center + Activity Feed */}
      <main className="flex-grow flex gap-6 relative z-10 px-6 py-6 overflow-hidden">
        {/* Left: Command Center */}
        <div className="flex-1 flex flex-col items-center justify-center">
          {/* Decorative Frame Elements */}
          <div className="absolute top-20 left-12 w-24 h-24 border-t border-l border-zinc-800 opacity-50 hidden sm:block pointer-events-none"></div>
          <div className="absolute bottom-20 left-12 w-24 h-24 border-b border-l border-zinc-800 opacity-50 hidden sm:block pointer-events-none"></div>

          {/* Header Label */}
          <div className="mb-12 text-center">
            <p className="text-[10px] uppercase tracking-[0.6em] text-zinc-500 font-medium mb-3">Primary Command Interface</p>
            <div className="h-[1px] w-48 bg-gradient-to-r from-transparent via-zinc-700 to-transparent mx-auto"></div>
          </div>

          {/* The Central Action Button */}
          <div className="relative group mb-12">
            <div className="absolute inset-0 bg-white/5 rounded-2xl blur-xl group-hover:bg-white/10 transition-all duration-500"></div>

            <motion.button
              id="homebase-button"
              ref={buttonRef}
              whileHover={BUTTON_HOVER}
              whileTap={BUTTON_TAP}
              animate={isIdle ? IDLE_PULSE : IDLE_REST}
              transition={isIdle ? IDLE_PULSE_TRANSITION : IDLE_REST_TRANSITION}
              onClick={handleClick}
              className="relative w-64 h-24 bg-zinc-900 border border-zinc-700 rounded-xl flex items-center justify-center shadow-2xl overflow-hidden cursor-pointer group-active:scale-95 transition-transform"
            >
              <div className="absolute inset-[1px] border border-white/5 rounded-[10px] pointer-events-none"></div>
              <span className="text-2xl font-bold tracking-[0.25em] uppercase text-zinc-100 group-hover:text-white transition-colors">
                Homebase
              </span>
              <div className="absolute top-2 left-2 w-1 h-1 bg-zinc-700"></div>
              <div className="absolute top-2 right-2 w-1 h-1 bg-zinc-700"></div>
              <div className="absolute bottom-2 left-2 w-1 h-1 bg-zinc-700"></div>
              <div className="absolute bottom-2 right-2 w-1 h-1 bg-zinc-700"></div>
            </motion.button>
          </div>

          {/* Bridge Status */}
          <div className="mb-8 text-center">
            <p className="text-[11px] italic font-serif text-zinc-600 tracking-widest">{bridgeText}</p>
          </div>

          {/* Alpha Script Control Panel */}
          <div className="border border-zinc-800 rounded-lg bg-zinc-900/30 backdrop-blur-sm p-6 max-w-md w-full">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-4">Alpha Scripts</p>
            <div className="grid grid-cols-2 gap-3">
              {ALPHA_SCRIPTS.map((script) => (
                <motion.button
                  key={script.id}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => handleRunScript(script.id)}
                  disabled={runningScript !== null}
                  className="relative px-4 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800/50 disabled:opacity-50 border border-zinc-700 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  {runningScript === script.id ? (
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                      className="inline-block"
                    >
                      ⟳
                    </motion.span>
                  ) : (
                    <span className="text-base">{script.icon}</span>
                  )}
                  <span className="text-[10px] uppercase tracking-wider font-semibold">{script.label}</span>
                </motion.button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Activity Feed */}
        <div className="w-80 flex flex-col border-l border-zinc-800 pl-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">Activity Feed</p>
            <button
              onClick={() => setShowActivityFeed(!showActivityFeed)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
              title="Toggle feed"
            >
              {showActivityFeed ? '▼' : '▶'}
            </button>
          </div>

          {showActivityFeed && (
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-thin scrollbar-track-zinc-900 scrollbar-thumb-zinc-700">
              {logsError ? (
                <div className="text-[10px] text-amber-600 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
                  {logsError}
                </div>
              ) : logs.length === 0 ? (
                <div className="text-[10px] text-zinc-600 italic">No activity yet</div>
              ) : (
                logs.map((entry, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-[9px] bg-zinc-900/50 border border-zinc-800 rounded px-2 py-2 space-y-1"
                  >
                    {entry.ts && (
                      <div className="text-zinc-500">
                        {new Date(entry.ts).toLocaleTimeString()}
                      </div>
                    )}
                    {entry.step && (
                      <div className="text-blue-400 font-semibold">{entry.step}</div>
                    )}
                    {entry.status && (
                      <div className={`font-semibold ${
                        entry.status === 'success' ? 'text-green-400' :
                        entry.status === 'error' ? 'text-red-400' :
                        'text-amber-400'
                      }`}>
                        {entry.status}
                      </div>
                    )}
                    {entry.message && (
                      <div className="text-zinc-300 truncate">{entry.message}</div>
                    )}
                    {entry.proposal_id && (
                      <div className="text-zinc-400">ID: {entry.proposal_id}</div>
                    )}
                  </motion.div>
                ))
              )}
            </div>
          )}
        </div>
      </main>

      {/* Bridge Health Card */}
      <div className="mx-4 sm:mx-8 mb-4 p-4 bg-zinc-900/80 border border-zinc-700/50 rounded-lg">
        {/* Flapping warning */}
        {bridgeHealth?.telemetry?.isFlapping && (
          <div className="mb-3 px-2 py-1 bg-amber-900/50 border border-amber-700 rounded flex items-center gap-2">
            <span className="text-amber-400 text-xs">⚡</span>
            <span className="font-mono text-[10px] text-amber-200">
              Flapping Detected ({bridgeHealth.telemetry.recentFailures || '?'}/10 failures)
            </span>
          </div>
        )}
        
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-zinc-300 uppercase tracking-wider">
              Bridge Health
            </span>
            {/* Overall status dot */}
            <span className={`w-2 h-2 rounded-full ${
              bridgeHealth?.ok 
                ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]' 
                : bridgeHealthError 
                ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'
                : 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]'
            }`}></span>
          </div>
          <div className="flex items-center gap-3">
            {bridgeHealthLastChecked && (
              <span className="font-mono text-[10px] text-zinc-500">
                Last checked: {bridgeHealthLastChecked}
              </span>
            )}
            <button
              onClick={handleRefreshBridge}
              className="font-mono text-[10px] px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
        
        {/* Telemetry metadata */}
        {(bridgeHealth?.telemetry?.firstFailureTime || bridgeHealth?.telemetry?.lastSuccessTime) && (
          <div className="mb-3 flex gap-4 text-[9px] text-zinc-500">
            {bridgeHealth.telemetry.firstFailureTime && (
              <span className="font-mono">
                First fail: {new Date(bridgeHealth.telemetry.firstFailureTime).toLocaleTimeString()}
              </span>
            )}
            {bridgeHealth.telemetry.lastSuccessTime && (
              <span className="font-mono">
                Last success: {new Date(bridgeHealth.telemetry.lastSuccessTime).toLocaleTimeString()}
              </span>
            )}
            <span className="font-mono">
              History: {bridgeHealth.telemetry.historyLength || 0}/50
            </span>
          </div>
        )}
        
        {/* Health rows */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {bridgeHealth && bridgeHealth.checks ? (
            Object.entries(bridgeHealth.checks).map(([key, check]: [string, any]) => (
              <div key={key} className="flex items-center gap-2 p-2 bg-zinc-950/50 rounded">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  check.ok 
                    ? 'bg-green-500' 
                    : 'bg-red-500'
                }`}></span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[10px] text-zinc-400 uppercase">
                    {key}
                  </div>
                  <div className="font-mono text-[9px] text-zinc-500 truncate" title={check.detail}>
                    {check.detail}
                  </div>
                </div>
                {check.latencyMs !== undefined && (
                  <span className="font-mono text-[8px] text-zinc-600">
                    {check.latencyMs}ms
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="col-span-4 text-center py-2">
              <span className="font-mono text-[10px] text-zinc-500">
                {bridgeHealthError ? 'Bridge unreachable' : 'Loading...'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Footer Status Bar */}
      <footer
        id="footer-status-strip"
        className="h-12 bg-[#0a0a0a] border-t border-zinc-800 flex items-center justify-between px-6 sm:px-10 relative z-20"
      >
        {/* Left Label: Version */}
        <div id="left-label" className="flex items-center gap-3">
          <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${dotColor}`}></div>
          <span className="font-mono text-[11px] font-semibold text-zinc-400 tracking-wider uppercase whitespace-nowrap">
            Homebase <span className="text-zinc-500 font-normal">{versionLabel}</span>
            <span className="text-zinc-600 font-normal ml-2">{shaLabel}</span>
          </span>
        </div>

        {/* Right Label: Clicks Counter */}
        <div
          id="right-label"
          className="flex items-center gap-4 cursor-pointer select-none"
          onDoubleClick={handleReset}
          title="Double-click to reset"
        >
          <div className="h-4 w-[1px] bg-zinc-800 hidden sm:block"></div>
          <div className="font-mono text-[11px] tracking-wider text-zinc-400 uppercase whitespace-nowrap">
            clicks:{' '}
            <motion.span
              key={clicks}
              initial={COUNT_INITIAL}
              animate={COUNT_ANIMATE}
              transition={COUNT_TRANSITION}
              className="font-bold inline-block min-w-[2ch]"
            >
              {clicks}
            </motion.span>
          </div>
        </div>
      </footer>
    </div>
  );
}
