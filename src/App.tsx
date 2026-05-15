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

      {/* TOP BUILDING BANNER — lands the launcher icon on whatever Notion is actively building. */}
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

      {/* Main Content Area */}
      <main className="flex-grow flex flex-col items-center justify-center relative z-10 px-8">
        {/* Decorative Frame Elements */}
        <div className="absolute top-12 left-12 w-24 h-24 border-t border-l border-zinc-800 opacity-50 hidden sm:block"></div>
        <div className="absolute top-12 right-12 w-24 h-24 border-t border-r border-zinc-800 opacity-50 hidden sm:block"></div>
        <div className="absolute bottom-12 left-12 w-24 h-24 border-b border-l border-zinc-800 opacity-50 hidden sm:block"></div>
        <div className="absolute bottom-12 right-12 w-24 h-24 border-b border-r border-zinc-800 opacity-50 hidden sm:block"></div>

        {/* Header Label */}
        <div className="mb-16 text-center">
          <p className="text-[10px] uppercase tracking-[0.6em] text-zinc-500 font-medium mb-3">Primary Command Interface</p>
          <div className="h-[1px] w-48 bg-gradient-to-r from-transparent via-zinc-700 to-transparent mx-auto"></div>
        </div>

        {/* The Central Action Button */}
        <div className="relative group">
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

        {/* Secondary Descriptor — now reflects real /api/health */}
        <div className="mt-12 text-center">
          <p className="text-[11px] italic font-serif text-zinc-600 tracking-widest">{bridgeText}</p>
        </div>
      </main>

      {/* Footer Status Bar (Strip) */}
      <footer
        id="footer-status-strip"
        className="h-12 bg-[#0a0a0a] border-t border-zinc-800 flex items-center justify-between px-6 sm:px-10 relative z-20"
      >
        {/* Left Label: Version (from /api/health) */}
        <div id="left-label" className="flex items-center gap-3">
          <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${dotColor}`}></div>
          <span className="font-mono text-[11px] font-semibold text-zinc-400 tracking-wider uppercase whitespace-nowrap">
            Homebase <span className="text-zinc-500 font-normal">{versionLabel}</span>
            <span className="text-zinc-600 font-normal ml-2">{shaLabel}</span>
          </span>
        </div>

        {/* Right Label: Clicks Counter (double-click to reset) */}
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
