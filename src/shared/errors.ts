import type { SerializedError } from './types';

/**
 * Every failure the engine and the shell can produce is identified by a stable
 * code. The code drives the log line, the tests and the copy shown to the user,
 * so the interface never has to pattern-match on a message.
 */
export const ERROR_CODES = [
  'PROJECT_IMPORT_FAILED',
  'UNSUPPORTED_PROJECT_FORMAT',
  'PROJECT_TOO_LARGE',
  'PROJECT_TOO_MANY_FILES',
  'ARCHIVE_UNSAFE_ENTRY',
  'ARCHIVE_ENTRY_MISSING_HTML',
  'PROJECT_NOT_FOUND',
  'BROWSER_LAUNCH_FAILED',
  'PAGE_LOAD_FAILED',
  'PAGE_LOAD_TIMEOUT',
  'RESOURCE_LOAD_WARNING',
  'PAGE_SCRIPT_ERROR',
  'RENDER_TIMEOUT',
  'RENDER_CANCELLED',
  'FRAME_CAPTURE_FAILED',
  'NO_FRAMES_CAPTURED',
  'ENCODER_MISSING',
  'ENCODING_FAILED',
  'OUTPUT_EXISTS',
  'OUTPUT_VALIDATION_FAILED',
  'OUTPUT_DIRECTORY_INVALID',
  'INSUFFICIENT_DISK_SPACE',
  'PROCESS_CRASHED',
  'RENDER_IN_PROGRESS',
  'INVALID_SETTINGS',
  'INVALID_IPC_ARGUMENT',
  'PREVIEW_UNAVAILABLE',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDefinition {
  /** Portuguese title shown in the interface. */
  title: string;
  /** Portuguese sentence explaining what happened and what to do next. */
  message: string;
  /** A recoverable error does not prevent retrying with other settings. */
  recoverable: boolean;
}

export const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  PROJECT_IMPORT_FAILED: {
    title: 'Não foi possível importar o projeto',
    message: 'O ficheiro foi lido mas não foi possível preparar o projeto. Verifique se o ficheiro não está em uso e tente novamente.',
    recoverable: true,
  },
  UNSUPPORTED_PROJECT_FORMAT: {
    title: 'Formato não suportado',
    message: 'A Biframe importa ficheiros .html, .htm e projetos .zip que contenham HTML.',
    recoverable: true,
  },
  PROJECT_TOO_LARGE: {
    title: 'Projeto demasiado grande',
    message: 'O projeto excede o limite configurado. Aumente o limite nas definições ou reduza o tamanho do projeto.',
    recoverable: true,
  },
  PROJECT_TOO_MANY_FILES: {
    title: 'Demasiados ficheiros no arquivo',
    message: 'O arquivo contém mais ficheiros do que o limite permitido. Aumente o limite nas definições ou simplifique o projeto.',
    recoverable: true,
  },
  ARCHIVE_UNSAFE_ENTRY: {
    title: 'Arquivo rejeitado por segurança',
    message: 'O arquivo contém caminhos que tentam sair da pasta do projeto. A importação foi interrompida.',
    recoverable: false,
  },
  ARCHIVE_ENTRY_MISSING_HTML: {
    title: 'Nenhum HTML encontrado no arquivo',
    message: 'O .zip não contém nenhum ficheiro HTML na raiz nem em subpastas.',
    recoverable: true,
  },
  PROJECT_NOT_FOUND: {
    title: 'Projeto não encontrado',
    message: 'O ficheiro ou a pasta do projeto já não existe. Importe o projeto novamente.',
    recoverable: true,
  },
  BROWSER_LAUNCH_FAILED: {
    title: 'Falha ao iniciar o motor de renderização',
    message: 'Não foi possível abrir o Chromium incluído na aplicação. Reinicie a Biframe; se o problema persistir, verifique os registos técnicos.',
    recoverable: true,
  },
  PAGE_LOAD_FAILED: {
    title: 'A página não carregou',
    message: 'O HTML foi aberto mas a página não terminou de carregar. Confirme que os recursos referenciados existem e que o ficheiro não está corrompido.',
    recoverable: true,
  },
  PAGE_LOAD_TIMEOUT: {
    title: 'A página demorou demasiado a carregar',
    message: 'A página excedeu o tempo máximo de carregamento. Verifique recursos externos lentos ou aumente o limite nas definições.',
    recoverable: true,
  },
  RESOURCE_LOAD_WARNING: {
    title: 'Recursos não carregaram',
    message: 'Alguns recursos da página falharam. O vídeo foi produzido, mas partes da animação podem estar incompletas.',
    recoverable: true,
  },
  PAGE_SCRIPT_ERROR: {
    title: 'Erro de JavaScript na página',
    message: 'A página lançou erros de JavaScript durante a animação. O resultado pode estar incompleto.',
    recoverable: true,
  },
  RENDER_TIMEOUT: {
    title: 'A renderização excedeu o tempo limite',
    message: 'A captura atingiu o limite de duração sem que a página indicasse o fim. Defina uma duração manual para este projeto.',
    recoverable: true,
  },
  RENDER_CANCELLED: {
    title: 'Renderização cancelada',
    message: 'A renderização foi cancelada a pedido. Os ficheiros temporários foram removidos.',
    recoverable: true,
  },
  FRAME_CAPTURE_FAILED: {
    title: 'Falha na captura de frames',
    message: 'O motor deixou de receber frames da página. Tente novamente com uma resolução menor.',
    recoverable: true,
  },
  NO_FRAMES_CAPTURED: {
    title: 'Nenhum frame capturado',
    message: 'A página não produziu imagens durante o período de captura. Verifique se a animação arranca sozinha.',
    recoverable: true,
  },
  ENCODER_MISSING: {
    title: 'Codificador indisponível',
    message: 'O FFmpeg incluído na aplicação não foi encontrado. Reinstale a Biframe ou verifique os registos técnicos.',
    recoverable: true,
  },
  ENCODING_FAILED: {
    title: 'Falha na codificação do vídeo',
    message: 'O FFmpeg não conseguiu produzir o MP4. Consulte os detalhes técnicos no registo.',
    recoverable: true,
  },
  OUTPUT_EXISTS: {
    title: 'Já existe um ficheiro com este nome',
    message: 'A pasta de destino já contém um vídeo com o nome escolhido. Escolha outro nome ou confirme a substituição.',
    recoverable: true,
  },
  OUTPUT_VALIDATION_FAILED: {
    title: 'O vídeo produzido não passou na validação',
    message: 'O ficheiro MP4 existe mas não corresponde às configurações pedidas. Verifique o registo técnico.',
    recoverable: true,
  },
  OUTPUT_DIRECTORY_INVALID: {
    title: 'Pasta de saída inválida',
    message: 'A pasta escolhida não existe ou não tem permissão de escrita. Escolha outra pasta.',
    recoverable: true,
  },
  INSUFFICIENT_DISK_SPACE: {
    title: 'Espaço em disco insuficiente',
    message: 'Não há espaço livre suficiente para os frames temporários e o vídeo final. Liberte espaço e tente novamente.',
    recoverable: true,
  },
  PROCESS_CRASHED: {
    title: 'Um processo do motor terminou inesperadamente',
    message: 'O Chromium ou o FFmpeg terminaram de forma inesperada. A tarefa foi interrompida e os ficheiros temporários removidos.',
    recoverable: true,
  },
  RENDER_IN_PROGRESS: {
    title: 'Já existe uma renderização em curso',
    message: 'Aguarde a conclusão da tarefa atual ou cancele-a antes de iniciar outra.',
    recoverable: true,
  },
  INVALID_SETTINGS: {
    title: 'Configurações inválidas',
    message: 'Uma das opções de exportação não é válida. Reveja a resolução, o FPS e a duração.',
    recoverable: true,
  },
  INVALID_IPC_ARGUMENT: {
    title: 'Pedido inválido',
    message: 'A interface enviou um pedido que não passou na validação. Isto indica um erro interno; reinicie a aplicação.',
    recoverable: true,
  },
  PREVIEW_UNAVAILABLE: {
    title: 'Pré-visualização indisponível',
    message: 'Não foi possível mostrar a pré-visualização nesta janela. A exportação continua disponível.',
    recoverable: true,
  },
  UNKNOWN_ERROR: {
    title: 'Ocorreu um erro inesperado',
    message: 'A operação falhou por um motivo não identificado. Consulte os registos técnicos para mais detalhes.',
    recoverable: true,
  },
};

export class BiframeError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly recoverable: boolean;

  constructor(code: ErrorCode, options: { detail?: string; cause?: unknown; message?: string } = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.message ?? definition.message);
    this.name = 'BiframeError';
    this.code = code;
    this.detail = options.detail;
    this.recoverable = definition.recoverable;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  get title(): string {
    return ERROR_DEFINITIONS[this.code].title;
  }

  toJSON(): SerializedError {
    const serialized: SerializedError = {
      code: this.code,
      title: this.title,
      message: this.message,
      recoverable: this.recoverable,
    };
    if (this.detail) serialized.detail = this.detail;
    return serialized;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Normalises anything thrown into a BiframeError with a technical detail. */
export function toBiframeError(error: unknown, fallback: ErrorCode = 'UNKNOWN_ERROR'): BiframeError {
  if (error instanceof BiframeError) return error;
  if (error instanceof Error) {
    return new BiframeError(fallback, {
      detail: error.stack ?? error.message,
      cause: error,
      message: error.message,
    });
  }
  return new BiframeError(fallback, { detail: String(error) });
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof BiframeError) return error.toJSON();
  return toBiframeError(error).toJSON();
}
