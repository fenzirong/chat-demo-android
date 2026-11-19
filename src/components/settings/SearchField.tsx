import {
  setSearchCount,
  setSearchProvider,
  setSearchReadPages,
  setSearxngUrl,
  setTavilyKey,
  useSettings,
  type SearchProviderSetting,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './Settings.module.css'

const PROVIDER_LABELS: Record<SearchProviderSetting, TranslationKey> = {
  auto: 'searchProviderAuto',
  bing: 'searchProviderBing',
  duckduckgo: 'searchProviderDuckDuckGo',
  searxng: 'searchProviderSearxng',
  wikipedia: 'searchProviderWikipedia',
  tavily: 'searchProviderTavily',
}

const PROVIDER_ORDER: SearchProviderSetting[] = [
  'auto',
  'bing',
  'duckduckgo',
  'searxng',
  'wikipedia',
  'tavily',
]

/**
 * 第三方服务商的联网搜索设置：数据源、实例/Key、条数与是否抓取正文。
 * 数据源全部是免费入口，Bing / DuckDuckGo / SearXNG 依赖应用内原生请求，网页版只有维基百科可用。
 */
export const SearchField = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.searchProvider)
  const searxngUrl = useSettings((state) => state.searxngUrl)
  const tavilyKey = useSettings((state) => state.tavilyKey)
  const count = useSettings((state) => state.searchCount)
  const readPages = useSettings((state) => state.searchReadPages)

  return (
    <div className={styles.cell}>
      <div className={styles.provider}>
        <div className={styles.row}>
          <div className={styles.label}>{t('settingsWebSearch')}</div>
          <Select
            ariaLabel={t('searchProviderLabel')}
            className={styles.providerSelect}
            value={provider}
            options={PROVIDER_ORDER.map((value) => ({ value, label: t(PROVIDER_LABELS[value]) }))}
            onChange={(value) => setSearchProvider(value)}
          />
        </div>
        <div className={styles.providerRow}>
          <Select
            ariaLabel={t('searchCountLabel')}
            className={styles.providerAuth}
            value={String(count)}
            options={['3', '5', '8', '10'].map((value) => ({
              value,
              label: t('searchCountOption', { count: value }),
            }))}
            onChange={(value) => setSearchCount(Number(value))}
          />
          <label className={styles.providerCheck}>
            <input
              type="checkbox"
              checked={readPages}
              onChange={(event) => setSearchReadPages(event.target.checked)}
            />
            {t('searchReadPagesLabel')}
          </label>
        </div>
        {provider === 'searxng' || provider === 'auto' ? (
          <input
            className={styles.providerInput}
            value={searxngUrl}
            placeholder={t('searxngUrlPlaceholder')}
            aria-label={t('searxngUrlLabel')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSearxngUrl(event.target.value)}
          />
        ) : null}
        {provider === 'tavily' ? (
          <input
            className={styles.providerInput}
            type="password"
            value={tavilyKey}
            placeholder={t('tavilyKeyLabel')}
            aria-label={t('tavilyKeyLabel')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTavilyKey(event.target.value)}
          />
        ) : null}
        <div className={styles.description}>{t('searchHintNative')}</div>
      </div>
    </div>
  )
}
