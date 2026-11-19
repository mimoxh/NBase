import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';
import type { EditorSize, ReadingPrefs } from './readingPrefs';
import type { ThemePreference } from './theme';
import './settings.css';

export interface SettingsSection { key: string; label: string; icon: IconName; content: ReactNode }

/** Sections mount on first visit and stay mounted, so unsaved input or a one-time invitation link survives switching tabs. */
export function SettingsDialog({ sections, initialSection, onClose }: {
  sections: SettingsSection[]; initialSection?: string; onClose: () => void;
}) {
  const [active, setActive] = useState(() => sections.some(item => item.key === initialSection) ? initialSection! : sections[0]?.key ?? '');
  const [visited, setVisited] = useState(() => new Set([active]));
  const current = sections.some(item => item.key === active) ? active : sections[0]?.key ?? '';
  const select = (key: string) => {
    setActive(key);
    setVisited(previous => previous.has(key) ? previous : new Set(previous).add(key));
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = sections.findIndex(item => item.key === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + step + sections.length) % sections.length;
    const key = sections[next]!.key;
    select(key);
    document.getElementById(`nb-settings-tab-${key}`)?.focus();
  };
  return <Modal title="设置" variant="large" onClose={onClose}>
    <div className="nb-settings">
      <div className="nb-settings-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类">
        {sections.map(item => <button key={item.key} id={`nb-settings-tab-${item.key}`} role="tab" type="button"
          className={`nb-settings-tab ${item.key === current ? 'selected' : ''}`} aria-selected={item.key === current}
          aria-controls={`nb-settings-panel-${item.key}`} tabIndex={item.key === current ? 0 : -1}
          onClick={() => select(item.key)} onKeyDown={move}>
          <Icon name={item.icon} size={15} /><span>{item.label}</span></button>)}
      </div>
      {sections.filter(item => visited.has(item.key) || item.key === current).map(item => <section key={item.key}
        id={`nb-settings-panel-${item.key}`} role="tabpanel" aria-labelledby={`nb-settings-tab-${item.key}`}
        className="nb-settings-panel" hidden={item.key !== current}>
        <h3 className="nb-settings-title">{item.label}</h3>
        {item.content}
      </section>)}
    </div>
  </Modal>;
}

export function SettingsGroup({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return <div className="nb-settings-group">
    {title && <h4>{title}</h4>}
    {description && <p className="nb-settings-hint">{description}</p>}
    <div className="nb-settings-card">{children}</div>
  </div>;
}

export function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="nb-settings-row">
    <div className="nb-settings-row-text"><span className="nb-settings-row-label">{label}</span>
      {description && <span className="nb-settings-row-desc">{description}</span>}</div>
    <div className="nb-settings-row-control">{children}</div>
  </div>;
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void;
}) {
  return <div className="nb-segmented" role="radiogroup" aria-label={label}>
    {options.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={value === key}
      className={value === key ? 'selected' : ''} onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="nb-switch"><input type="checkbox" role="switch" aria-label={label} checked={checked}
    onChange={event => onChange(event.target.checked)} /><span aria-hidden="true" /></label>;
}

const themeOptions = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const;
const sizeOptions = [['small', '小'], ['normal', '标准'], ['large', '大']] as const;

export function AppearanceSettings({ theme, onTheme, reading, onReading }: {
  theme: ThemePreference; onTheme: (theme: ThemePreference) => void;
  reading: ReadingPrefs; onReading: (patch: Partial<ReadingPrefs>) => void;
}) {
  return <>
    <SettingsGroup title="外观">
      <SettingsRow label="主题" description="跟随系统时随操作系统的深浅色自动切换。">
        <Segmented<ThemePreference> label="主题" value={theme} options={themeOptions} onChange={onTheme} /></SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="阅读" description="这些设置只保存在当前浏览器，不会改动页面内容。">
      <SettingsRow label="正文字号">
        <Segmented<EditorSize> label="正文字号" value={reading.size} options={sizeOptions} onChange={size => onReading({ size })} /></SettingsRow>
      <SettingsRow label="全宽页面" description="正文铺满可用宽度。">
        <Switch label="全宽页面" checked={reading.wide} onChange={wide => onReading({ wide })} /></SettingsRow>
      <SettingsRow label="专注模式" description="隐藏侧栏、目录和编辑工具栏；可在页面菜单中退出。">
        <Switch label="专注模式" checked={reading.focus} onChange={focus => onReading({ focus })} /></SettingsRow>
    </SettingsGroup>
  </>;
}

export function AccountSettings({ loginName, workspaceName, roleLabel, onLogout }: {
  loginName: string; workspaceName: string; roleLabel: string; onLogout: () => void;
}) {
  return <SettingsGroup>
    <SettingsRow label="账号"><span className="nb-settings-value">{loginName}</span></SettingsRow>
    <SettingsRow label="工作区"><span className="nb-settings-value">{workspaceName}</span></SettingsRow>
    <SettingsRow label="角色"><span className="nb-settings-value">{roleLabel}</span></SettingsRow>
    <SettingsRow label="退出登录" description="本机未保存的草稿会保留，用同一账号重新登录后可以找回。">
      <button type="button" className="nb-btn" onClick={onLogout}><Icon name="logout" size={14} /> 退出登录</button></SettingsRow>
  </SettingsGroup>;
}
