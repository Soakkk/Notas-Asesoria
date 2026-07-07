import React, { useEffect, useState } from 'react';
import { Settings, X, Check, KeyRound, ExternalLink } from 'lucide-react';

interface ApiKeySettingsProps {
  onConfigured?: () => void;
}

export const ApiKeySettings: React.FC<ApiKeySettingsProps> = ({ onConfigured }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const refreshStatus = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setHasApiKey(!!data.hasApiKey);
    } catch {
      setHasApiKey(false);
    }
  };

  useEffect(() => {
    refreshStatus();
  }, []);

  const handleSave = async () => {
    if (!apiKeyInput.trim()) {
      setError('Pega tu clave de API de Gemini antes de guardar.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar la clave.');

      setHasApiKey(true);
      setApiKeyInput('');
      setSaved(true);
      onConfigured?.();
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || 'Error al guardar la clave.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
          hasApiKey
            ? 'bg-slate-50 text-slate-600 hover:bg-slate-100 border-slate-200'
            : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200'
        }`}
        id="btn-open-settings"
      >
        <Settings className="w-3.5 h-3.5" />
        <span>{hasApiKey ? 'Ajustes' : 'Configurar API Key'}</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center text-white">
                  <KeyRound className="w-4.5 h-4.5" />
                </div>
                <h2 className="font-display font-bold text-sm text-slate-900">
                  Clave de API de Gemini
                </h2>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-slate-700"
                id="btn-close-settings"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed mb-3">
              Esta clave se guarda únicamente en este ordenador (nunca se sube a internet ni a GitHub) y permite
              que la app lea las capturas de pantalla con IA. Consíguela gratis en{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-slate-800 underline inline-flex items-center gap-0.5"
              >
                Google AI Studio <ExternalLink className="w-3 h-3" />
              </a>.
            </p>

            <div className="mb-2 text-[11px] font-semibold text-slate-500">
              Estado actual:{' '}
              {hasApiKey === null ? (
                <span className="text-slate-400">comprobando…</span>
              ) : hasApiKey ? (
                <span className="text-emerald-600">clave configurada ✓</span>
              ) : (
                <span className="text-amber-600">sin configurar</span>
              )}
            </div>

            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Pega aquí tu clave de Google AI Studio"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-slate-800 bg-slate-50/50 font-mono mb-2"
            />

            {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition-all disabled:opacity-50"
              id="btn-save-api-key"
            >
              {saved ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>¡Guardada!</span>
                </>
              ) : (
                <span>{saving ? 'Guardando…' : 'Guardar clave'}</span>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
