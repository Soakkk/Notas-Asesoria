// Validación determinista de los datos extraídos por la IA.
// Estos algoritmos son los oficiales (checksum del IBAN, letra del NIF/NIE/CIF),
// así que detectan con total fiabilidad un dígito mal leído por Gemini, que es
// el fallo típico del OCR: no dependen de ninguna llamada externa.

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface FieldCheck {
  field: 'iban' | 'cliente_nif' | 'importe' | 'periodo' | 'modelo' | 'cliente_nombre' | 'ejercicio' | 'tipo_resultado';
  status: CheckStatus;
  message: string;
}

export interface VerificationResult {
  estado: 'ok' | 'revisar';
  checks: FieldCheck[];
  /** Campos en los que la segunda lectura de la IA no coincidió con la primera */
  discrepanciasIA?: string[];
  /** true si la segunda lectura con IA llegó a ejecutarse */
  segundaLecturaHecha?: boolean;
}

// ---- IBAN (mod-97, ISO 7064) ----

export function validateIBAN(iban: string): FieldCheck {
  const clean = (iban || '').replace(/[\s-]+/g, '').toUpperCase();
  if (!clean) {
    return { field: 'iban', status: 'warn', message: 'No se ha capturado ningún IBAN.' };
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(clean)) {
    return { field: 'iban', status: 'error', message: 'El IBAN tiene un formato irreconocible.' };
  }
  if (clean.startsWith('ES') && clean.length !== 24) {
    return {
      field: 'iban', status: 'error',
      message: `Un IBAN español tiene 24 caracteres y este tiene ${clean.length}. Falta o sobra algún dígito.`,
    };
  }
  // Mod-97: mover los 4 primeros caracteres al final y convertir letras a números (A=10..Z=35)
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(String(remainder) + numeric.slice(i, i + 7), 10) % 97;
  }
  if (remainder !== 1) {
    return {
      field: 'iban', status: 'error',
      message: 'El IBAN no supera la comprobación oficial (mod-97): hay algún dígito mal leído. Compárelo con la captura.',
    };
  }
  return { field: 'iban', status: 'ok', message: 'IBAN correcto (checksum verificado).' };
}

// ---- NIF / NIE / CIF ----

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

export function validateNIF(nif: string): FieldCheck {
  const clean = (nif || '').replace(/[\s.-]+/g, '').toUpperCase();
  if (!clean || clean === 'PENDIENTE') {
    return { field: 'cliente_nif', status: 'warn', message: 'No se ha capturado el NIF del cliente.' };
  }

  // DNI: 8 dígitos + letra
  if (/^\d{8}[A-Z]$/.test(clean)) {
    const expected = DNI_LETTERS[parseInt(clean.slice(0, 8), 10) % 23];
    if (clean[8] !== expected) {
      return {
        field: 'cliente_nif', status: 'error',
        message: `La letra del NIF no cuadra con el número (sería «${expected}»): hay algún dígito mal leído.`,
      };
    }
    return { field: 'cliente_nif', status: 'ok', message: 'NIF correcto (letra de control verificada).' };
  }

  // NIE: X/Y/Z + 7 dígitos + letra
  if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
    const prefix = { X: '0', Y: '1', Z: '2' }[clean[0] as 'X' | 'Y' | 'Z'];
    const expected = DNI_LETTERS[parseInt(prefix + clean.slice(1, 8), 10) % 23];
    if (clean[8] !== expected) {
      return {
        field: 'cliente_nif', status: 'error',
        message: `La letra del NIE no cuadra con el número (sería «${expected}»): hay algún dígito mal leído.`,
      };
    }
    return { field: 'cliente_nif', status: 'ok', message: 'NIE correcto (letra de control verificada).' };
  }

  // CIF: letra + 7 dígitos + dígito o letra de control
  if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
    const digits = clean.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const n = parseInt(digits[i], 10);
      if (i % 2 === 0) {
        const dbl = n * 2;
        sum += Math.floor(dbl / 10) + (dbl % 10);
      } else {
        sum += n;
      }
    }
    const controlDigit = (10 - (sum % 10)) % 10;
    const controlLetter = 'JABCDEFGHI'[controlDigit];
    const given = clean[8];
    const ok = given === String(controlDigit) || given === controlLetter;
    if (!ok) {
      return {
        field: 'cliente_nif', status: 'error',
        message: `El dígito de control del CIF no cuadra (sería «${controlDigit}» o «${controlLetter}»): hay algún dígito mal leído.`,
      };
    }
    return { field: 'cliente_nif', status: 'ok', message: 'CIF correcto (dígito de control verificado).' };
  }

  return {
    field: 'cliente_nif', status: 'warn',
    message: 'El NIF/CIF no tiene un formato español reconocible. Revise la captura.',
  };
}

// ---- Resto de campos ----

const MODELOS_CONOCIDOS = new Set([
  '100', '102', '111', '115', '117', '123', '130', '131', '136',
  '151', '180', '182', '184', '190', '193', '200', '202', '210',
  '216', '220', '222', '303', '308', '309', '322', '347', '349',
  '353', '360', '361', '368', '369', '390', '714', '720', '721',
]);

export function validateModelo(modelo: string): FieldCheck {
  const clean = (modelo || '').trim();
  if (!clean) return { field: 'modelo', status: 'error', message: 'No se ha capturado el número de modelo.' };
  if (!MODELOS_CONOCIDOS.has(clean)) {
    return {
      field: 'modelo', status: 'warn',
      message: `El modelo «${clean}» no está en la lista de modelos AEAT habituales. Compruébelo.`,
    };
  }
  return { field: 'modelo', status: 'ok', message: `Modelo ${clean} reconocido.` };
}

export function validatePeriodo(periodo: string): FieldCheck {
  const clean = (periodo || '').toUpperCase().trim();
  if (/^[1-4]T$/.test(clean)) return { field: 'periodo', status: 'ok', message: 'Periodo trimestral válido.' };
  const n = parseInt(clean, 10);
  if (!isNaN(n) && n >= 1 && n <= 12 && /^\d{1,2}$/.test(clean)) {
    return { field: 'periodo', status: 'ok', message: 'Periodo mensual válido.' };
  }
  if (/^0A$/.test(clean)) return { field: 'periodo', status: 'ok', message: 'Periodo anual (0A).' };
  return {
    field: 'periodo', status: 'error',
    message: `El periodo «${periodo}» no es válido (debe ser 1T-4T, 01-12 o 0A).`,
  };
}

export function validateEjercicio(ejercicio: string): FieldCheck {
  const n = parseInt((ejercicio || '').trim(), 10);
  const current = new Date().getFullYear();
  if (isNaN(n) || n < 2000 || n > current + 1) {
    return {
      field: 'ejercicio', status: 'error',
      message: `El ejercicio «${ejercicio}» no parece un año válido.`,
    };
  }
  if (n < current - 4) {
    return {
      field: 'ejercicio', status: 'warn',
      message: `El ejercicio ${n} es de hace más de 4 años; compruebe que la captura es la correcta.`,
    };
  }
  return { field: 'ejercicio', status: 'ok', message: 'Ejercicio válido.' };
}

export function validateImporte(importe: number, tipoResultado?: string): FieldCheck {
  if (typeof importe !== 'number' || !isFinite(importe)) {
    return { field: 'importe', status: 'error', message: 'El importe no es un número válido.' };
  }
  if (importe === 0) {
    if (tipoResultado === 'Resultado cero / Sin actividad') {
      return { field: 'importe', status: 'ok', message: 'Importe 0,00 € coherente con «Sin actividad».' };
    }
    return { field: 'importe', status: 'warn', message: 'Importe 0,00 €: compruebe si es correcto (¿sin actividad?).' };
  }
  if (Math.abs(importe) > 300000) {
    return {
      field: 'importe', status: 'warn',
      message: 'Importe inusualmente alto: compruebe que la coma decimal se ha leído bien.',
    };
  }
  return { field: 'importe', status: 'ok', message: 'Importe con formato válido.' };
}

export function validateNombre(nombre: string): FieldCheck {
  const clean = (nombre || '').trim();
  if (!clean || clean.toLowerCase() === 'cliente desconocido') {
    return { field: 'cliente_nombre', status: 'error', message: 'No se ha capturado el nombre del cliente.' };
  }
  if (clean.length < 5) {
    return { field: 'cliente_nombre', status: 'warn', message: 'El nombre del cliente parece incompleto.' };
  }
  if (/[^\p{L}\p{N}\s.,'’&-]/u.test(clean)) {
    return { field: 'cliente_nombre', status: 'warn', message: 'El nombre contiene caracteres extraños; puede haberse leído mal.' };
  }
  return { field: 'cliente_nombre', status: 'ok', message: 'Nombre con formato válido.' };
}

/**
 * Ejecuta todas las validaciones deterministas sobre los datos de un aviso.
 * El IBAN solo se valida si el resultado es Domiciliación o hay devolución
 * (que es cuando la cuenta importa de verdad).
 */
const RESULTADOS_VALIDOS = new Set([
  'Domiciliación',
  'A ingresar',
  'A compensar',
  'Resultado negativo',
  'Resultado cero / Sin actividad',
  'Devolución',
]);

export function validateTipoResultado(tipoResultado: string, importe: number): FieldCheck {
  const tipo = (tipoResultado || '').trim();
  if (!RESULTADOS_VALIDOS.has(tipo)) {
    return {
      field: 'tipo_resultado',
      status: 'error',
      message: `El resultado «${tipo || 'vacío'}» no es una opción fiscal reconocida.`,
    };
  }
  if ((tipo === 'Domiciliación' || tipo === 'A ingresar') && importe < 0) {
    return {
      field: 'tipo_resultado',
      status: 'warn',
      message: `El resultado es «${tipo}», pero el importe es negativo. Compruebe el signo y el tipo de resultado.`,
    };
  }
  if (tipo === 'Resultado negativo' && importe > 0) {
    return {
      field: 'tipo_resultado',
      status: 'warn',
      message: 'El resultado figura como negativo, pero el importe es positivo. Compruebe el signo.',
    };
  }
  if (tipo === 'Resultado cero / Sin actividad' && Math.abs(importe) >= 0.01) {
    return {
      field: 'tipo_resultado',
      status: 'warn',
      message: 'El resultado figura sin actividad, pero el importe no es 0,00 €.',
    };
  }
  return { field: 'tipo_resultado', status: 'ok', message: 'Tipo de resultado coherente.' };
}

export function verifyNoticeFields(data: {
  modelo: string;
  periodo: string;
  ejercicio: string;
  cliente_nif: string;
  cliente_nombre: string;
  importe: number;
  tipo_resultado: string;
  iban?: string;
}): FieldCheck[] {
  const checks: FieldCheck[] = [
    validateModelo(data.modelo),
    validatePeriodo(data.periodo),
    validateEjercicio(data.ejercicio),
    validateNIF(data.cliente_nif),
    validateNombre(data.cliente_nombre),
    validateImporte(data.importe, data.tipo_resultado),
    validateTipoResultado(data.tipo_resultado, data.importe),
  ];
  const needsIban = data.tipo_resultado === 'Domiciliación' || data.tipo_resultado === 'Devolución';
  if (needsIban || (data.iban || '').trim()) {
    checks.push(validateIBAN(data.iban || ''));
  }
  return checks;
}

/** Normaliza un NIF para usarlo como clave de agrupación de cliente. */
export function normalizeNifKey(nif: string, nombre: string): string {
  const cleanNif = (nif || '').replace(/[\s.-]+/g, '').toUpperCase();
  if (cleanNif && cleanNif !== 'PENDIENTE') return cleanNif;
  return (nombre || 'NIF-PENDIENTE').replace(/\s+/g, '').toUpperCase();
}
