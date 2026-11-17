import type { AppEnv } from '../config/env.js';
import { LocalContextLoader } from '../context/LocalContextLoader.js';
import { STAGE_CONFIG, type StageName } from '../context/stages.js';
import { log } from '../core/logger.js';
import { maskSecret } from '../providers/EndpointProfile.js';
import { resolveEndpoint, resolveProviderKind } from '../providers/EndpointResolver.js';
import { normalizeOpenAIBaseUrl } from '../providers/url.js';

/**
 * Diagnostics for the two questions that used to be answered only by a runtime
 * crash: "what endpoint + model will actually be used?" and "does that model
 * exist there?".
 *
 *   ai doctor   -> effective configuration (env > context.json > defaults)
 *   ai models   -> what the endpoint actually exposes (GET /models)
 */

export interface DoctorReport {
  providerKind: string;
  providerKindSource: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  apiKeySource: string;
  model: string | undefined;
  modelSource: string;
  fallbacks: string[];
  contextFile: string | null;
  contextProvider: string | undefined;
  perStage: Array<{ stage: string; model: string | undefined }>;
  warnings: string[];
}

/** Build the effective configuration report (no network). */
export function buildDoctorReport(env: AppEnv): DoctorReport {
  const resolved = resolveEndpoint(env);
  const local = LocalContextLoader.load(env.cwd);
  const warnings: string[] = [];

  const perStage = (Object.keys(STAGE_CONFIG) as StageName[])
    .map((stage) => ({ stage, model: local.config.models?.[stage] }))
    .filter((entry) => entry.model !== undefined);

  if (resolved.profile.kind === 'kiro') {
    warnings.push(
      'Nenhum endpoint HTTP configurado: caindo em Kiro (CLI/SSO). Se esperava Groq/DeepSeek, defina HARNESS_BASE_URL.',
    );
  }
  if (resolved.profile.requiresApiKey && !resolved.profile.apiKey) {
    warnings.push(`Credencial ausente para ${resolved.profile.label}.`);
  }
  if (local.config.provider && local.config.provider !== 'auto') {
    warnings.push(
      `.harness/context.json fixa provider="${local.config.provider}" — sobrepõe a detecção automática.`,
    );
  }
  if (perStage.length > 0) {
    warnings.push(
      '.harness/context.json define models por stage — esses nomes vencem HARNESS_MODEL.',
    );
  }

  return {
    providerKind: resolveProviderKind(env),
    providerKindSource: resolved.sources.kind,
    label: resolved.profile.label,
    baseUrl: resolved.profile.baseUrl ?? '(não configurada)',
    apiKey: maskSecret(resolved.profile.apiKey),
    apiKeySource: resolved.sources.apiKey,
    model: resolved.profile.defaultModel,
    modelSource: resolved.sources.model,
    fallbacks: env.HARNESS_MODEL_FALLBACKS
      ? env.HARNESS_MODEL_FALLBACKS.split(',')
          .map((m) => m.trim())
          .filter(Boolean)
      : [],
    contextFile: local.dir ? `${local.dir}/context.json` : null,
    contextProvider: local.config.provider,
    perStage,
    warnings,
  };
}

/** Render the report as human-readable text. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Provider      : ${report.providerKind} (${report.providerKindSource})`);
  lines.push(`Endpoint      : ${report.label}`);
  lines.push(`Base URL      : ${report.baseUrl}`);
  lines.push(`API Key       : ${report.apiKey} (${report.apiKeySource})`);
  lines.push(`Model         : ${report.model ?? '(provider default)'} (${report.modelSource})`);
  lines.push(
    `Fallbacks     : ${report.fallbacks.length > 0 ? report.fallbacks.join(', ') : '(nenhum)'}`,
  );
  lines.push(
    `Context       : ${report.contextFile ?? '(sem .harness/)'}` +
      (report.contextProvider ? ` · provider=${report.contextProvider}` : ''),
  );

  if (report.perStage.length > 0) {
    lines.push(
      `Per-stage     : ${report.perStage.map((s) => `${s.stage}=${s.model}`).join(', ')}`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push('');
    for (const w of report.warnings) lines.push(`⚠ ${w}`);
  }
  return lines.join('\n');
}

export interface ModelsProbe {
  ok: boolean;
  status?: number;
  url: string;
  count: number;
  models: string[];
  error?: string;
}

/**
 * Probe the endpoint's model catalog (`GET {base}/models`).
 * Works for OpenAI, Groq, DeepSeek, OpenRouter, Ollama and most compatible
 * gateways; providers without the route simply report the HTTP status.
 */
export async function probeModels(env: AppEnv, timeoutMs = 15_000): Promise<ModelsProbe> {
  const resolved = resolveEndpoint(env);
  const base = resolved.profile.baseUrl;

  if (!base) {
    return {
      ok: false,
      url: '(sem base URL)',
      count: 0,
      models: [],
      error: 'HARNESS_BASE_URL ausente',
    };
  }

  const url =
    resolved.profile.kind === 'claude'
      ? `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`
      : `${normalizeOpenAIBaseUrl(base)}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: resolved.profile.apiKey
        ? { Authorization: `Bearer ${resolved.profile.apiKey}` }
        : {},
      signal: controller.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return {
        ok: false,
        status: resp.status,
        url,
        count: 0,
        models: [],
        error: `HTTP ${resp.status}: ${txt.slice(0, 300)}`,
      };
    }

    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();

    return { ok: true, status: resp.status, url, count: models.length, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, url, count: 0, models: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Log a probe result, highlighting whether the configured model is present. */
export function reportModelsProbe(probe: ModelsProbe, configured: string | undefined): void {
  if (!probe.ok) {
    log.err(`GET ${probe.url} falhou: ${probe.error ?? 'erro desconhecido'}`);
    return;
  }

  log.ok(`GET ${probe.url} → ${probe.status} · ${probe.count} modelo(s)`);

  if (!configured) {
    log.info('Nenhum modelo configurado — use --model ou HARNESS_MODEL.');
  } else if (probe.models.includes(configured)) {
    log.ok(`Modelo "${configured}" disponível neste endpoint.`);
  } else {
    log.warn(`Modelo "${configured}" NÃO aparece em GET /models deste endpoint.`);
    const tail = configured.split('/').pop() ?? configured;
    const similar = probe.models.filter((m) => m.includes(tail)).slice(0, 5);
    if (similar.length > 0) log.info(`Parecidos: ${similar.join(', ')}`);
  }

  for (const m of probe.models.slice(0, 40)) log.info(`  ${m}`);
  if (probe.models.length > 40) log.info(`  … e mais ${probe.models.length - 40}`);
}
