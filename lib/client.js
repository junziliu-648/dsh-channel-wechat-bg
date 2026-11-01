/**
 * 插件自己的设置页 —— 挂在「设置」里的一级入口（slot: settings.section），
 * 不是插件详情页里那张小卡片。
 *
 * 手写 lazy-CJS 而不是 ESM：宿主给客户端插件用的加载器就是这个形状 ——
 * `window.__ModuleLoader__.load({ id, factory(require) })`，factory 返回
 * `{ name, inject, apply }`。写成 ESM 的话文件会被加载器整个忽略，
 * 页面上什么都不会出现，也不报错。
 *
 * 两个约定必须守住：
 *   - 接口路径必须**以 / 开头**（绝对路径）。设置页的文档 URL 带层级，
 *     写相对路径 `api/...` 会解析到错误的位置、拿到 404；
 *   - 注册 `settings.section` 时 `label` 就是左侧导航里显示的标题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-channel-wechat-bg',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本包的包名。 */
    const PLUGIN_ID = 'dsh-channel-wechat-bg'
    /** 设置接口（绝对路径，见文件头注释）。 */
    const SETTINGS_PATH = '/api/channel-wechat-bg/settings'

    const styles = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        maxWidth: '720px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      lead: {
        fontSize: '13px',
        lineHeight: '1.7',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      hint: {
        fontSize: '12px',
        lineHeight: '1.7',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '320px',
        overflowY: 'auto',
      },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: '8px',
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
      },
      itemName: { flex: '1 1 auto' },
      itemId: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
        fontSize: '11px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      input: {
        width: '80px',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      button: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '13px',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary, #4a7dff)',
        background: 'var(--dsw-alias-brand-primary, #4a7dff)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      },
      error: {
        color: 'var(--dsw-alias-state-danger-primary, #e0544e)',
        fontSize: '12px',
        lineHeight: '1.6',
      },
      ok: {
        color: 'var(--dsw-alias-state-success-primary, #3fa45b)',
        fontSize: '12px',
        lineHeight: '1.6',
      },
    }

    /**
     * 读一次设置快照。
     * @returns {Promise<object>} 快照。
     */
    async function loadSettings() {
      const response = await fetch(SETTINGS_PATH, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    /**
     * 保存：只提交勾选的群 id 和唤醒前缀，别的都归配置文件管。
     * @param {string[]} groupIds - 勾选的群 id。
     * @param {string} wakePrefix - 唤醒前缀。
     * @returns {Promise<object>} 保存后的快照。
     */
    async function saveSettings(groupIds, wakePrefix, stickerRate) {
      const response = await fetch(SETTINGS_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ groupIds, wakePrefix, stickerRate }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    /**
     * 设置页本体。
     *
     * 它只做一件事：把「哪些群算数」和「群里怎么叫我」变成可点的东西。
     * 私聊不在这个页面里 —— 跟谁私聊是配置文件里写死的，一个勾选框不该能改它。
     *
     * @returns {object} React 元素。
     */
    function SettingsSection() {
      const [rows, setRows] = React.useState([])
      const [prefix, setPrefix] = React.useState('!')
      const [stickerRate, setStickerRate] = React.useState('more')
      const [rates, setRates] = React.useState([])
      const [personas, setPersonas] = React.useState([])
      const [memory, setMemory] = React.useState({ dir: '', sessions: 0, people: 0 })
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [settingsPath, setSettingsPath] = React.useState('')

      const applySnapshot = (snapshot) => {
        setRows(Array.isArray(snapshot.groups) ? snapshot.groups : [])
        setPrefix(typeof snapshot.wakePrefix === 'string' ? snapshot.wakePrefix : '!')
        setSettingsPath(typeof snapshot.settingsPath === 'string' ? snapshot.settingsPath : '')
        setStickerRate(typeof snapshot.stickerRate === 'string' ? snapshot.stickerRate : 'more')
        setRates(Array.isArray(snapshot.stickerRates) ? snapshot.stickerRates : [])
        setPersonas(Array.isArray(snapshot.personas) ? snapshot.personas : [])
        if (snapshot.memory && typeof snapshot.memory === 'object') setMemory(snapshot.memory)
        if (typeof snapshot.availableError === 'string' && snapshot.availableError !== '') {
          setNotice(`列群服务暂时不可用：${snapshot.availableError}`)
        } else {
          setNotice('')
        }
      }

      const reload = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          applySnapshot(await loadSettings())
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void reload()
      }, [reload])

      const toggle = (id) => {
        setRows((current) =>
          current.map((row) => (row.id === id ? { ...row, selected: !row.selected } : row)),
        )
        setNotice('')
      }

      const onSave = async () => {
        setSaving(true)
        setError('')
        setNotice('')
        try {
          const selected = rows.filter((row) => row.selected === true).map((row) => row.id)
          applySnapshot(await saveSettings(selected, prefix, stickerRate))
          setNotice('已保存，下一次收到消息就按这个来。')
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason))
        } finally {
          setSaving(false)
        }
      }

      const selectedCount = rows.filter((row) => row.selected === true).length

      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.lead },
          '微信通道只服务白名单里的会话。这里能改的是群聊白名单、群里的唤醒前缀和表情频率；人格文件和记忆存在磁盘上，改文件或删文件立刻生效。',
        ),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, '群聊唤醒前缀'),
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              value: prefix,
              placeholder: '!',
              spellCheck: false,
              onChange: (event) => {
                setPrefix(event.target.value)
                setNotice('')
              },
            }),
            h(
              'span',
              { style: styles.hint },
              '群里只有带着它（或者直接 @ 我）说话，才会被当成在叫我',
            ),
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, '表情频率'),
          h(
            'div',
            { style: styles.row },
            h(
              'select',
              {
                style: styles.input,
                value: stickerRate,
                onChange: (event) => {
                  setStickerRate(event.target.value)
                  setNotice('')
                },
              },
              (rates.length > 0 ? rates : [{ id: 'more', label: '多' }]).map((rate) =>
                h('option', { key: rate.id, value: rate.id }, rate.label),
              ),
            ),
            h('span', { style: styles.hint }, '越往后越爱发表情包；「疯狂」几乎每条都配一张'),
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, '人格'),
          h(
            'div',
            { style: styles.hint },
            '私聊和群聊各读一份人设文件；群聊优先读 <名字>-group.md。想改性格就改文件，下一句就生效。',
          ),
          personas.length === 0
            ? h('div', { style: styles.hint }, '还没有白名单会话。')
            : h(
                'div',
                { style: styles.list },
                personas.map((row) =>
                  h(
                    'div',
                    { key: row.id, style: styles.item },
                    h(
                      'span',
                      { style: styles.itemName },
                      `${row.kind === 'group' ? '群' : '私聊'} · ${row.label || row.id}`,
                    ),
                    h(
                      'span',
                      { style: styles.itemId },
                      row.file === '' ? '没有配人设' : `${row.file}${row.builtin ? '（内置）' : ''}`,
                    ),
                  ),
                ),
              ),
        ),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, '记忆'),
          h(
            'div',
            { style: styles.hint },
            `会话 ${memory.sessions || 0} 份、人物 ${memory.people || 0} 份。存到 ${memory.dir || '（未配置目录）'}`,
          ),
          h(
            'div',
            { style: styles.hint },
            '聊天里说「[记住: …]」会写进对应的文件；删掉某个文件就等于让它忘掉那个人/那段对话。',
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('div', { style: styles.cardTitle }, `群聊白名单（已选 ${selectedCount}）`),
            h(
              'button',
              { style: styles.button, onClick: reload, disabled: loading || saving },
              loading ? '读取中…' : '刷新列表',
            ),
          ),
          h(
            'div',
            { style: styles.hint },
            '勾上的群会被回复，没勾的群消息直接丢掉。列表来自微信本身，勾选后保存即可。',
          ),
          rows.length === 0
            ? h(
                'div',
                { style: styles.hint },
                loading ? '正在读微信里的群…' : '没有读到群。可以点「刷新列表」重试。',
              )
            : h(
                'div',
                { style: styles.list },
                rows.map((row) =>
                  h(
                    'label',
                    { key: row.id, style: styles.item },
                    h('input', {
                      type: 'checkbox',
                      checked: row.selected === true,
                      onChange: () => toggle(row.id),
                    }),
                    h('span', { style: styles.itemName }, row.name || row.id),
                    h('span', { style: styles.itemId }, row.id),
                  ),
                ),
              ),
          error !== '' ? h('div', { style: styles.error }, error) : null,
          notice !== '' ? h('div', { style: styles.ok }, notice) : null,
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                style: { ...styles.button, ...styles.primary },
                onClick: onSave,
                disabled: loading || saving,
              },
              saving ? '保存中…' : '保存',
            ),
            settingsPath !== ''
              ? h('span', { style: styles.hint }, `存到 ${settingsPath}`)
              : null,
          ),
        ),
      )
    }

    return {
      name: PLUGIN_ID,
      inject: ['slots'],
      /**
       * 注册到「设置」弹层左侧的一级入口。
       *
       * `settings.section` 是 list 插槽：每个注册项就是一整个设置页，
       * `label` 直接显示成导航标题。
       *
       * @param {object} ctx - 客户端 Context。
       * @returns {void}
       */
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'wechat-bg',
              order: 52,
              locale: PLUGIN_ID,
              label: () => '微信通道',
            },
            SettingsSection,
          ),
        )
      },
    }
  },
})
