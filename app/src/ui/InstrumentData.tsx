/** Live DHT11 dashboard from the wildfire instrument server. */
const INSTRUMENT_URL = "http://127.0.0.1:8000/";

export function InstrumentData({ onBack }: { onBack: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-void">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-[11px] tracking-[0.16em] text-ink-dim">LIVE INSTRUMENT DATA</span>
        <button
          onClick={onBack}
          className="flex h-9 items-center border border-line bg-panel px-3 text-[11px] tracking-wider text-ink-dim transition hover:border-line-strong hover:text-ink"
        >
          BACK
        </button>
      </div>
      <iframe title="Live instrument data" src={INSTRUMENT_URL} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
