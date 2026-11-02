import { useCallback, useEffect, useRef, useState } from 'react';
import { AsciiEngine, DEFAULT_SETTINGS, type Mode, type Settings, type Stats } from './engine';

const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const STORE_KEY = 'webasciitube:settings';
const ACCEPT = 'video/*,image/*';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  const s = { ...DEFAULT_SETTINGS };
  if (window.innerWidth < 600) s.fontSize = 7;
  return s;
}

const MODES: { value: Mode; label: string }[] = [
  { value: 'dir', label: '| / - \\' },
  { value: 'solid', label: '#' },
  { value: 'shade', label: '윤곽+명암' },
];

function AsciiSlider(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { id, label, min, max, step, value, format, onChange } = props;
  const cells = 20;
  const filled = Math.round(((value - min) / (max - min)) * cells);
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <div className="slider-track">
        <span aria-hidden="true">
          [{'#'.repeat(filled)}
          <span className="dim">{'.'.repeat(cells - filled)}</span>]
        </span>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <output htmlFor={id}>{format(value)}</output>
    </div>
  );
}

function Toggle(props: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle" htmlFor={props.id}>
      <input id={props.id} type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span aria-hidden="true">[{props.checked ? 'x' : ' '}]</span> {props.label}
    </label>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AsciiEngine | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const barBtnRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const toastTimer = useRef(0);

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2200);
  }, []);

  // 엔진 생성
  useEffect(() => {
    const engine = new AsciiEngine(canvasRef.current!, settings, FONT);
    engine.onStats = setStats;
    engineRef.current = engine;
    engine.start();
    document.fonts?.load(`16px ${FONT}`).then(() => engine.measure());
    const onResize = () => engine.markDirty();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 설정 반영 + 저장
  useEffect(() => {
    engineRef.current?.setSettings(settings);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
      /* 무시 */
    }
  }, [settings]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const loadFile = useCallback(
    (file: File | undefined) => {
      const engine = engineRef.current;
      if (!file || !engine) return;
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      if (!isVideo && !isImage) {
        showToast('영상이나 사진 파일만 열 수 있습니다.');
        return;
      }
      const url = URL.createObjectURL(file);
      if (isImage) {
        const img = new Image();
        img.onload = () => {
          engine.setImage(img, file.name);
          URL.revokeObjectURL(url);
          setHasFile(true);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          showToast('이 사진을 열지 못했습니다.');
        };
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.addEventListener(
          'loadeddata',
          () => {
            engine.setVideo(v, file.name);
            v.play().catch(() => {});
            setHasFile(true);
          },
          { once: true },
        );
        v.addEventListener(
          'error',
          () => {
            URL.revokeObjectURL(url);
            showToast('브라우저가 이 영상 형식을 재생하지 못합니다. MP4(H.264)나 WebM으로 바꿔 보세요.');
          },
          { once: true },
        );
        v.src = url;
      }
    },
    [showToast],
  );

  const pickFile = () => fileRef.current?.click();

  const copyFrame = useCallback(() => {
    const text = engineRef.current?.getText() ?? '';
    navigator.clipboard
      ?.writeText(text)
      .then(() => showToast('현재 프레임을 텍스트로 복사했습니다.'))
      .catch(() => showToast('클립보드에 복사하지 못했습니다.'));
  }, [showToast]);

  const closeModal = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => barBtnRef.current?.focus());
  }, []);

  // 모달 열릴 때 첫 버튼에 포커스
  useEffect(() => {
    if (open) modalRef.current?.querySelector<HTMLElement>('.group button')?.focus();
  }, [open]);

  // 키보드
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        closeModal();
        return;
      }
      if (t.closest('input, button, select, textarea')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engineRef.current?.togglePlay();
      } else if (e.key === 'o' || e.key === 'O') {
        setOpen((v) => !v);
      } else if (e.key === 'c' || e.key === 'C') {
        copyFrame();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeModal, copyFrame]);

  // 창 전체 드래그 앤 드롭
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      loadFile(e.dataTransfer?.files[0]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [loadFile]);

  const engine = engineRef.current;
  const isVideo = stats?.kind === 'video';
  const canPlay = stats?.kind !== 'image';
  const statusLine = stats
    ? `${stats.name} · ${stats.srcW}×${stats.srcH} → ${stats.cols}×${stats.rows}` +
      (stats.playing ? ` · ${Math.round(stats.fps)}fps` : stats.kind === 'image' ? '' : ' · 정지')
    : '준비 중';

  return (
    <>
      <canvas ref={canvasRef} className="stage" aria-label="아스키 아트 출력" />

      <input
        ref={fileRef}
        id="file-input"
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          loadFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {!hasFile && !open && (
        <section className="intro" aria-labelledby="intro-title">
          <h1 id="intro-title">
            <span className="dim">[</span>WebASCIITube<span className="dim">]</span>
          </h1>
          <p>영상이나 사진을 창에 끌어다 놓으면 윤곽선만 아스키 문자로 바꿔 화면 전체에 그립니다.</p>
          <button type="button" className="btn primary" onClick={pickFile}>
            [ 파일 선택 ]
          </button>
          <p className="dim small">mp4 · webm · mov · jpg · png · gif · webp — 파일은 이 브라우저 안에서만 처리됩니다</p>
          <p className="dim small">뒤에 보이는 건 데모 장면입니다</p>
        </section>
      )}

      {dragging && (
        <div className="drop" aria-hidden="true">
          <pre>{'+------------------------+\n|   여기에 놓으세요      |\n+------------------------+'}</pre>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {open && <div className="backdrop" onClick={closeModal} aria-hidden="true" />}

      <div className="dock">
        {open && (
          <div className="panel" role="dialog" aria-modal="true" aria-label="렌더 옵션" ref={modalRef}>
            <span className="corner tl" aria-hidden="true">+</span>
            <span className="corner tr" aria-hidden="true">+</span>
            <span className="corner bl" aria-hidden="true">+</span>
            <span className="corner br" aria-hidden="true">+</span>
            <div className="panel-body">

            <div className="panel-head">
              <span>-- 옵션</span>
              <button type="button" className="btn ghost" onClick={closeModal} aria-label="옵션 닫기">
                [ x ]
              </button>
            </div>

            <div className="group">
              <span className="label">소스</span>
              <div className="row">
                <button type="button" className="btn primary" onClick={pickFile}>
                  [ 파일 바꾸기 ]
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    engine?.useDemo();
                    setHasFile(false);
                  }}
                  disabled={stats?.kind === 'demo'}
                >
                  [ 데모 ]
                </button>
              </div>
              <span className="dim small status">{statusLine}</span>
            </div>

            <div className="group">
              <span className="label">재생</span>
              <div className="row">
                <button type="button" className="btn" onClick={() => engine?.togglePlay()} disabled={!canPlay}>
                  {stats?.playing ? '[ || 일시정지 ]' : '[ >  재생 ]'}
                </button>
                <button type="button" className="btn" onClick={() => engine?.toggleMute()} disabled={!isVideo}>
                  {isVideo && !stats?.muted ? '[ 소리 끄기 ]' : '[ 소리 켜기 ]'}
                </button>
                <button type="button" className="btn" onClick={copyFrame}>
                  [ 프레임 복사 ]
                </button>
              </div>
            </div>

            <div className="group">
              <span className="label">렌더</span>
              <AsciiSlider
                id="font-size"
                label="글자 크기"
                min={4}
                max={24}
                step={1}
                value={settings.fontSize}
                format={(v) => `${v}px`}
                onChange={(v) => update('fontSize', v)}
              />
              <AsciiSlider
                id="threshold"
                label="윤곽 기준"
                min={0.04}
                max={0.6}
                step={0.01}
                value={settings.threshold}
                format={(v) => v.toFixed(2)}
                onChange={(v) => update('threshold', v)}
              />
              <div className="seg" role="radiogroup" aria-label="문자 방식">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.mode === m.value}
                    className={'btn' + (settings.mode === m.value ? ' on' : '')}
                    onClick={() => update('mode', m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="row toggles">
                <Toggle id="opt-color" label="원본 색" checked={settings.color} onChange={(v) => update('color', v)} />
                <Toggle id="opt-blur" label="노이즈 줄이기" checked={settings.blur} onChange={(v) => update('blur', v)} />
                <Toggle id="opt-thin" label="얇은 선" checked={settings.thin} onChange={(v) => update('thin', v)} />
              </div>
            </div>

            <p className="dim small keys">Space 재생/정지 · O 옵션 · C 복사 · Esc 닫기</p>
            </div>
          </div>
        )}

        <button
          ref={barBtnRef}
          type="button"
          className={'bar' + (open ? ' is-open' : '')}
          aria-expanded={open}
          onClick={() => (open ? closeModal() : setOpen(true))}
        >
          {open ? '[ v 닫기 ]' : '[ ^ 옵션 ]'}
        </button>
        {!open && <span className="bar-status dim small">{statusLine}</span>}
      </div>
    </>
  );
}
