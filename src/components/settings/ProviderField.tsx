import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import {
  PROVIDER_PRESETS,
  applyPreset,
  isProviderConfigured,
  normalizeBaseUrl,
  type ProviderConfig,
} from '../../services/providers.js'
import { setProvider, useSettings } from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './Settings.module.css'

const PRESET_LABEL_KEYS: Record<string, TranslationKey> = {
  deepseek: 'providerPresetDeepseek',
  commandcode: 'providerPresetCommandcode',
  openai: 'providerPresetOpenai',
  'custom-anthropic': 'providerPresetCustomAnthropic',
  'custom-openai': 'providerPresetCustomOpenai',
}

type TestResult = { ok: boolean; text: string }

/**
 * 服务商设置：预设 + 接口地址 + 模型 + 鉴权方式，并可在保存前测试连接。
 * 地址与模型逐字保存，失焦时才做规范化（补协议、去尾部斜杠），避免边输入边改写。
 */
export const ProviderField = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const apiKey = useSettings((state) => state.apiKey)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const update = (patch: Partial<ProviderConfig>) => {
    setResult(null)
    setProvider({ ...provider, ...patch })
  }

  const describeFailure = (error: unknown): string => {
    if (classifyApiError(error) === 'unauthorized') {
      return t('apiKeyInvalid')
    }
    if (classifyApiError(error) === 'network') {
      return t('commonNetworkErrorToast')
    }
    const message =
      error instanceof ApiError && error.localMessage
        ? t(error.localMessage.key, error.localMessage.params)
        : error instanceof Error
          ? error.message
          : String(error)
    return t('providerTestFailed', { message })
  }

  const test = async () => {
    const current = useSettings.getState().provider
    if (!isProviderConfigured(current)) {
      setResult({ ok: false, text: t('providerIncomplete') })
      return
    }
    const key = useSettings.getState().apiKey
    if (!key) {
      setResult({ ok: false, text: t('providerNeedKey') })
      return
    }
    setTesting(true)
    setResult(null)
    try {
      await verifyApiKey(current, key)
      setResult({ ok: true, text: t('providerTestOk') })
    } catch (error) {
      setResult({ ok: false, text: describeFailure(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.provider}>
        <div className={styles.row}>
          <div className={styles.label}>{t('settingsProvider')}</div>
          <Select
            ariaLabel={t('settingsProvider')}
            className={styles.providerSelect}
            value={provider.id}
            options={PROVIDER_PRESETS.map((preset) => ({
              value: preset.id,
              label: t(PRESET_LABEL_KEYS[preset.id] ?? 'settingsProvider'),
            }))}
            onChange={(id) => {
              setResult(null)
              setProvider(applyPreset(provider, id))
            }}
          />
        </div>
        <div className={styles.providerFields}>
          <input
            className={styles.providerInput}
            value={provider.baseUrl}
            placeholder={t('providerBaseUrlPlaceholder')}
            aria-label={t('providerBaseUrl')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ baseUrl: event.target.value })}
            onBlur={(event) => {
              const next = normalizeBaseUrl(event.target.value)
              if (next !== provider.baseUrl) {
                update({ baseUrl: next })
              }
            }}
          />
          <input
            className={styles.providerInput}
            value={provider.model}
            placeholder={t('providerModelPlaceholder')}
            aria-label={t('providerModel')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ model: event.target.value })}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next !== provider.model) {
                update({ model: next })
              }
            }}
          />
        </div>
        <div className={styles.providerRow}>
          <Select
            ariaLabel={t('providerAuthMode')}
            className={styles.providerAuth}
            value={provider.authMode}
            options={[
              { value: 'bearer', label: t('providerAuthBearer') },
              { value: 'x-api-key', label: t('providerAuthApiKey') },
            ]}
            onChange={(value) => update({ authMode: value === 'x-api-key' ? 'x-api-key' : 'bearer' })}
          />
          {provider.protocol === 'anthropic' ? (
            <label className={styles.providerCheck}>
              <input
                type="checkbox"
                checked={provider.anthropicVersion !== null}
                onChange={(event) =>
                  update({ anthropicVersion: event.target.checked ? '2023-06-01' : null })
                }
              />
              {t('providerAnthropicVersion')}
            </label>
          ) : null}
          <button
            type="button"
            className={styles.confirm}
            disabled={testing}
            onClick={() => void test()}
          >
            {testing ? t('providerTesting') : t('providerTest')}
          </button>
        </div>
        <div className={styles.description}>{t('providerCapabilityHint')}</div>
        {result ? (
          <div className={result.ok ? styles.hint : styles.error} role="status">
            {result.text}
          </div>
        ) : null}
        {!apiKey ? <div className={styles.error}>{t('providerNeedKey')}</div> : null}
      </div>
    </div>
  )
}
