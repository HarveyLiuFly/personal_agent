import React, { useState } from 'react';
import type { ProjectView } from '../../../packages/contracts/src/views.ts';
import { AutonomyDialog } from './autonomy-manager.tsx';
import { BackupManager } from './backup-manager.tsx';
import { NativeHistory } from './native-history.tsx';
import { PanelBoundary } from './panel-boundary.tsx';
import { ProjectSkillsDialog } from './skills-panel.tsx';
import { TaskManager } from './task-manager.tsx';

type Section = 'general' | 'memory' | 'usage' | 'history';
const sections: Array<{ id: Section; label: string; action: string; needsProject: boolean }> = [
  { id: 'general', label: '通用', action: 'settings-general', needsProject: false },
  { id: 'memory', label: '记忆', action: 'open-memory', needsProject: true },
  { id: 'usage', label: '任务与用量', action: 'open-tasks', needsProject: true },
  { id: 'history', label: '原生历史', action: 'open-native-history', needsProject: true },
];

interface Props {
  project?: ProjectView;
  canCode: boolean;
  canBrowseSkills: boolean;
  backgroundEnabled: boolean;
  /** The connection status line. */
  connection: React.ReactNode;
  onBusyChange: (busy: boolean) => void;
  onOpenConversation: (conversationId: string) => void;
  onStarted: (runId: string) => void;
}

/** Settings: app-wide parts first; memory, tasks and history are for the current project. */
export function SettingsPage(props: Props) {
  const { project } = props;
  const [section, setSection] = useState<Section>('general'),
    [skillsOpen, setSkillsOpen] = useState(false);
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分区">
        {sections.map((item) => (
          <button
            key={item.id}
            data-action={item.action}
            className={section === item.id ? 'active' : ''}
            aria-current={section === item.id ? 'page' : undefined}
            disabled={item.needsProject && !project}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="page-content settings-page">
        <PanelBoundary key={section} name="这个设置分区">
          {section === 'general' && (
            <>
              <div className="page-heading">
                <div>
                  <h2>通用</h2>
                  <p className="muted">连接、能力和本机数据。</p>
                </div>
              </div>
              <section className="settings-card">
                <h3>Codex 连接</h3>
                <p>使用本机支持的登录方式，通过 App Server 执行任务。</p>
                {props.connection}
              </section>
              {project && (
                <section className="settings-card">
                  <h3>项目能力</h3>
                  <p>查看 {project.name} 中已发现的技能与当前可用能力。</p>
                  <button
                    className="secondary"
                    data-action="open-project-skills"
                    disabled={!props.canBrowseSkills}
                    onClick={() => setSkillsOpen(true)}
                  >
                    查看技能与能力
                  </button>
                </section>
              )}
              <section className="settings-card">
                <h3>本机数据</h3>
                <BackupManager />
              </section>
              <section className="settings-card">
                <h3>运行方式</h3>
                <p>
                  {props.backgroundEnabled
                    ? '关闭窗口后本机任务继续；退出应用或电脑休眠时暂停。'
                    : '当前仅前台执行。'}
                </p>
              </section>
            </>
          )}
          {section === 'memory' && project && (
            <AutonomyDialog
              key={project.id}
              project={project}
              embedded
              initialTab="memory"
              onClose={() => setSection('general')}
            />
          )}
          {section === 'usage' && project && (
            <TaskManager
              key={project.id}
              project={project}
              canCode={props.canCode}
              standalone
              section="tasks"
              onBusyChange={props.onBusyChange}
              onTask={props.onOpenConversation}
              onStarted={props.onStarted}
            />
          )}
          {section === 'history' && project && <NativeHistory key={project.id} project={project} />}
        </PanelBoundary>
      </div>
      {skillsOpen && project && (
        <ProjectSkillsDialog
          project={project}
          onBusyChange={props.onBusyChange}
          onClose={() => setSkillsOpen(false)}
        />
      )}
    </div>
  );
}
