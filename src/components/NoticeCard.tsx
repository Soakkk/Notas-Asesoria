import React, { useRef, useState } from 'react';
import { toBlob, toPng } from 'html-to-image';
import { JointNotice, formatDateSpanish } from '../types';
import { Copy, Check, Download, Calendar, Info } from 'lucide-react';

export type CardFormat = 'A' | 'B' | 'C';

interface NoticeCardProps {
  notice: JointNotice;
  format: CardFormat;
}

// --- Paleta del manual de estilo ---
const NAVY = '#1D3B5F';
const PAGE = '#FBF9F5';
const BORDER = '#E7E0D4';
const ROW = '#EBE5DA';
const NOTE_BG = '#F3EFE8';
const LABEL = '#8C8577';
const INK = '#2B2B2B';
const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'Consolas', 'Courier New', monospace";

const euro = (n: number) => {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${withSep},${dec} €`;
};

const maskIban = (iban?: string) => {
  if (!iban) return '';
  const clean = iban.replace(/\s+/g, '');
  return clean.replace(/^([A-Z]{2}\d{2})\d+(\d{4})$/, '$1 **** **** $2') || iban;
};

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dateShort = (d: Date) => `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;

const TAX_NAMES: Record<string, string> = {
  '303': 'IVA', '322': 'IVA', '390': 'IVA anual', '349': 'Intracomunitarias',
  '111': 'Retenciones', '115': 'Alquileres', '123': 'Retenciones',
  '130': 'IRPF', '131': 'IRPF', '100': 'Renta',
  '200': 'Sociedades', '202': 'Sociedades',
  '190': 'Retenciones anual', '180': 'Retenciones anual', '347': 'Operaciones terceros',
};
const shortTaxName = (modelo: string, nombre: string) =>
  TAX_NAMES[modelo] || (nombre && nombre.length <= 16 ? nombre : `Modelo ${modelo}`);

const periodoLabel = (p: string) => {
  const t: Record<string, string> = { '1T': '1.er trimestre', '2T': '2.º trimestre', '3T': '3.er trimestre', '4T': '4.º trimestre' };
  if (t[p]) return t[p];
  const n = parseInt(p, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return MONTHS[n - 1].charAt(0).toUpperCase() + MONTHS[n - 1].slice(1);
  return p;
};

export const NoticeCard: React.FC<NoticeCardProps> = ({ notice, format }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const single = notice.notices.length === 1 ? notice.notices[0] : null;
  const first = notice.notices[0];
  const isRefund = notice.total_importe < 0;
  const totalAmount = euro(Math.abs(notice.total_importe));

  const chargeDate = notice.notices.length
    ? notice.notices.map((n) => new Date(n.fechaCargo)).sort((a, b) => a.getTime() - b.getTime())[0]
    : null;

  const res = (() => {
    const dateTxt = chargeDate ? dateShort(chargeDate) : '';
    if (notice.todosDomiciliados)
      return {
        label: 'Domiciliado', c: '#23603B', bg: '#EAF3EC', bd: '#CFE5D5', dot: '#2E6B43',
        msg: `No tiene que hacer nada. La Agencia Tributaria cargará ${totalAmount} en su cuenta el ${dateTxt}. Asegúrese de tener saldo suficiente ese día.`,
        shortMsg: 'Se cargará automáticamente en su cuenta.',
        iban: true, dateLabel: 'Fecha de cargo',
      };
    if (single && single.tipo_resultado === 'A compensar')
      return {
        label: 'A compensar', c: '#23507F', bg: '#EAF1F8', bd: '#D3E1EF', dot: '#2E5AA8',
        msg: `No tiene que pagar nada este periodo. El saldo a su favor de ${totalAmount} se descontará automáticamente en sus próximas declaraciones.`,
        shortMsg: 'Se descontará en próximas declaraciones.',
        iban: false, dateLabel: '',
      };
    if (isRefund || (single && single.tipo_resultado === 'Devolución'))
      return {
        label: 'A devolver', c: '#22685A', bg: '#E7F3F0', bd: '#C9E5DE', dot: '#2C7A6B',
        msg: `La Agencia Tributaria le devolverá ${totalAmount}. El abono puede tardar unas semanas en hacerse efectivo.`,
        shortMsg: 'Hacienda le devolverá el importe.',
        iban: true, dateLabel: '',
      };
    if (single && single.tipo_resultado === 'Resultado cero / Sin actividad')
      return {
        label: 'Sin actividad', c: '#5C564A', bg: '#F0ECE3', bd: '#E0D8C9', dot: '#6B6456',
        msg: 'Declaración presentada sin importe a pagar ni a devolver. No tiene que hacer nada.',
        shortMsg: 'Presentada sin importe.',
        iban: false, dateLabel: '',
      };
    return {
      label: 'A pagar', c: '#8A5A12', bg: '#FBF1E0', bd: '#EFDEBE', dot: '#B4761E',
      msg: `Debe realizar el ingreso de ${totalAmount} antes del ${dateTxt} para evitar recargos de la Agencia Tributaria.`,
      shortMsg: 'Recuerde ingresarlo antes de la fecha límite.',
      iban: false, dateLabel: 'Fecha límite',
    };
  })();

  const chip = single ? `Modelo ${single.modelo}` : `${notice.notices.length} impuestos`;
  const taxBig = single ? shortTaxName(single.modelo, single.modelo_nombre) : 'Resumen de impuestos';
  const periodoText = `${periodoLabel(first?.periodo || '')} ${first?.ejercicio || ''}`.trim();
  const amountLabel = single
    ? (notice.todosDomiciliados ? 'Importe domiciliado' : res.label === 'A compensar' ? 'Saldo a compensar' : res.label === 'A devolver' ? 'Importe a devolver' : res.label === 'Sin actividad' ? 'Importe' : 'Importe a ingresar')
    : (notice.todosDomiciliados ? 'Total domiciliado' : isRefund ? 'Total a devolver' : 'Total a pagar');

  const exportOpts = { pixelRatio: 2, backgroundColor: PAGE, cacheBust: true, skipFonts: true };

  const handleCopy = async () => {
    if (!cardRef.current) return;
    try {
      await toBlob(cardRef.current, exportOpts);
      const blob = await toBlob(cardRef.current, exportOpts);
      if (!blob) throw new Error('sin imagen');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Error copiando la imagen', err);
      handleDownload();
    }
  };

  const handleDownload = async () => {
    if (!cardRef.current) return;
    try {
      await toPng(cardRef.current, exportOpts);
      const dataUrl = await toPng(cardRef.current, exportOpts);
      const link = document.createElement('a');
      link.download = `Aviso_${notice.cliente_nombre.replace(/\s+/g, '_')}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Error descargando la imagen', err);
    }
  };

  // Tamaño del importe auto-ajustado a su longitud: un total de 7 cifras a
  // tamaño fijo se salía de la ficha (o se solapaba) en la imagen exportada.
  // Nunca se recorta un dato del cliente con «…»: mejor letra algo menor o
  // salto de línea que un aviso con el importe o el nombre a medias.
  const fitAmount = (base: number) => {
    const len = totalAmount.length;
    if (len <= 11) return base;
    if (len <= 13) return Math.round(base * 0.88);
    if (len <= 15) return Math.round(base * 0.78);
    return Math.round(base * 0.68);
  };

  // ---- Cabecera: título del resultado ARRIBA DEL TODO, luego el cliente ----
  const Header = () => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          {single && (
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', color: NAVY, textTransform: 'uppercase' }}>Resultado liquidación</div>
          )}
          <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 19, color: NAVY, lineHeight: 1.2, marginTop: single ? 1 : 0, overflowWrap: 'break-word' }}>{taxBig}</div>
          <div style={{ fontSize: 12, color: LABEL, marginTop: 3 }}>{periodoText}</div>
        </div>
        <span style={{ background: NAVY, color: '#fff', fontSize: 11, fontWeight: 600, padding: '3px 11px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0 }}>{chip}</span>
      </div>
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${ROW}` }}>
        <div style={{ fontFamily: SERIF, fontSize: 16, color: INK, lineHeight: 1.3, wordBreak: 'break-word' }}>{notice.cliente_nombre}</div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: LABEL, marginTop: 2, overflowWrap: 'break-word' }}>NIF {notice.cliente_nif}</div>
      </div>
    </>
  );

  const Desglose = () => (
    <div style={{ fontSize: 13 }}>
      {notice.notices.map((tax) => (
        <div key={tax.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, padding: '6px 0', borderTop: `1px solid ${ROW}` }}>
          <span style={{ color: INK, minWidth: 0, overflowWrap: 'break-word' }}>
            <span style={{ fontWeight: 700 }}>Modelo {tax.modelo}</span>
            <span style={{ color: LABEL }}> · {shortTaxName(tax.modelo, tax.modelo_nombre)}</span>
          </span>
          <span style={{ fontFamily: SERIF, whiteSpace: 'nowrap', flexShrink: 0 }}>{euro(tax.importe)}</span>
        </div>
      ))}
    </div>
  );

  const CuentaRow = () =>
    res.iban && notice.iban ? (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: `1px solid ${ROW}`, fontSize: 13, flexWrap: 'wrap' }}>
        <span style={{ color: LABEL, whiteSpace: 'nowrap' }}>Cuenta de cargo</span>
        <span style={{ fontFamily: MONO, color: '#5C564A', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{maskIban(notice.iban)}</span>
      </div>
    ) : null;

  const FechaRow = () =>
    res.dateLabel && chargeDate ? (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: `1px solid ${ROW}`, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: LABEL, whiteSpace: 'nowrap' }}>
          <Calendar size={15} color={NAVY} style={{ flexShrink: 0 }} />
          {res.dateLabel}
        </span>
        <span style={{ fontFamily: SERIF, fontSize: 13.5, color: INK, whiteSpace: 'nowrap' }}>{formatDateSpanish(chargeDate)}</span>
      </div>
    ) : null;

  // Nota: solo en domiciliaciones. Pide revisar la cuenta y dar conformidad.
  const Nota = () =>
    notice.todosDomiciliados ? (
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 11, background: NOTE_BG, border: `1px solid ${ROW}`, borderRadius: 10, padding: '9px 12px' }}>
        <Info size={14} color={NAVY} style={{ marginTop: 1, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, color: '#6B6456', lineHeight: 1.45 }}>
          Por favor, revise que el número de cuenta es correcto y autorícenos a domiciliar el cargo en ella.
        </span>
      </div>
    ) : null;

  const StatusLine = () => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: res.bg, border: `1px solid ${res.bd}`, borderRadius: 10, padding: '10px 13px' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: res.dot, flexShrink: 0, marginTop: 4 }} />
      <span style={{ fontSize: 13, color: res.c, lineHeight: 1.4 }}>
        <span style={{ fontWeight: 700 }}>{res.label}</span> — {res.shortMsg}
      </span>
    </div>
  );

  // ---- Cuerpos por formato ----
  const BodyA = () => (
    <>
      <div style={{ background: res.bg, border: `1px solid ${res.bd}`, borderRadius: 12, padding: '13px 15px', margin: '13px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: res.c, fontSize: 15, fontWeight: 700 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: res.dot, flexShrink: 0 }} />
            {res.label}
          </div>
          <div style={{ fontSize: 12.5, color: res.c, marginTop: 3, lineHeight: 1.4 }}>{res.shortMsg}</div>
        </div>
        <div style={{ fontFamily: SERIF, fontSize: fitAmount(26), color: res.c, whiteSpace: 'nowrap', flexShrink: 0 }}>{totalAmount}</div>
      </div>
      {!single && <Desglose />}
      <CuentaRow />
      <FechaRow />
      <Nota />
    </>
  );

  const BodyB = () => (
    <>
      {!single && <div style={{ marginTop: 12 }}><Desglose /></div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: `2px solid ${NAVY}`, marginTop: single ? 12 : 5 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: NAVY, letterSpacing: single ? 0 : '0.04em', whiteSpace: 'nowrap' }}>{single ? amountLabel : 'TOTAL'}</span>
        <span style={{ fontFamily: SERIF, fontSize: fitAmount(25), color: NAVY, whiteSpace: 'nowrap', flexShrink: 0 }}>{totalAmount}</span>
      </div>
      <div style={{ margin: '8px 0 2px' }}><StatusLine /></div>
      <CuentaRow />
      <FechaRow />
      <Nota />
    </>
  );

  const BodyC = () => (
    <>
      <div style={{ textAlign: 'center', padding: '14px 0 10px' }}>
        <div style={{ fontSize: 12, color: LABEL, letterSpacing: '0.04em' }}>{amountLabel}</div>
        <div style={{ fontFamily: SERIF, fontSize: fitAmount(36), color: NAVY, lineHeight: 1.05, margin: '5px 0 9px', whiteSpace: 'nowrap' }}>{totalAmount}</div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: res.c, fontSize: 14, fontWeight: 700, background: res.bg, border: `1px solid ${res.bd}`, padding: '4px 12px', borderRadius: 999 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: res.dot }} />
          {res.label}
        </span>
      </div>
      {!single && (
        <div style={{ fontSize: 12.5, color: '#6B6456', padding: '10px 0', borderTop: `1px solid ${ROW}`, textAlign: 'center', lineHeight: 1.7 }}>
          {notice.notices.map((tax, i) => (
            <span key={tax.id}>
              {i > 0 && <span style={{ color: '#D6CFC0' }}>&nbsp;&nbsp;|&nbsp;&nbsp;</span>}
              <span style={{ fontWeight: 700, color: INK }}>{tax.modelo}</span>{' '}
              {shortTaxName(tax.modelo, tax.modelo_nombre)} · {euro(tax.importe).replace(' €', '')}
            </span>
          ))}
        </div>
      )}
      {(res.dateLabel || (res.iban && notice.iban)) && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: single ? `1px solid ${ROW}` : 'none', textAlign: 'center' }}>
          {res.dateLabel && chargeDate && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Calendar size={15} color={NAVY} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: INK, whiteSpace: 'nowrap' }}>
                {res.dateLabel === 'Fecha límite' ? 'Ingresar antes del ' : 'Cargo el '}
                <span style={{ fontFamily: SERIF }}>{dateShort(chargeDate)}</span>
              </span>
            </div>
          )}
          {res.iban && notice.iban && (
            <div style={{ fontFamily: MONO, fontSize: 12.5, color: '#5C564A', letterSpacing: '0.03em', marginTop: 6, whiteSpace: 'nowrap' }}>{maskIban(notice.iban)}</div>
          )}
        </div>
      )}
      <Nota />
    </>
  );

  return (
    <div className="w-full flex flex-col items-center">
      {/* ===== FICHA (lo que se exporta a imagen): tarjeta cuadrada y limpia ===== */}
      <div
        ref={cardRef}
        style={{
          width: 440,
          boxSizing: 'border-box',
          background: PAGE,
          border: `1px solid ${BORDER}`,
          fontFamily: "'Segoe UI', Arial, 'Helvetica Neue', sans-serif",
          color: INK,
        }}
      >
        <div style={{ padding: '18px 20px' }}>
          <Header />
          {format === 'A' && <BodyA />}
          {format === 'B' && <BodyB />}
          {format === 'C' && <BodyC />}
        </div>
      </div>

      {/* ===== Botones ===== */}
      <div className="flex gap-3 mt-4 w-full justify-center">
        <button
          onClick={handleCopy}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold rounded-lg text-white bg-slate-800 hover:bg-slate-900 transition-colors shadow-sm"
          id={`btn-copy-img-${notice.cliente_nif}`}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>¡Copiada al portapapeles!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copiar Imagen para WhatsApp</span>
            </>
          )}
        </button>

        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
          id={`btn-dl-img-${notice.cliente_nif}`}
        >
          <Download className="w-3.5 h-3.5" />
          <span>Descargar PNG</span>
        </button>
      </div>
    </div>
  );
};
