import { createRoot } from 'react-dom/client';
import PilotWorkspace from './PilotWorkspace';
import './style.css';

const params = new URLSearchParams(window.location.search);
const workflowIds = params.getAll('workflow');
const workflowId = workflowIds.length === 1 && /^[A-Za-z0-9_-]{1,120}$/.test(workflowIds[0]) ? workflowIds[0] : null;
createRoot(document.getElementById('root')!).render(
  workflowId
    ? <PilotWorkspace workflowId={workflowId} />
    : <main><h1>无法打开流程</h1><p>请从企业入口选择一个有效流程。</p></main>,
);
