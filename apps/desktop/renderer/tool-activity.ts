import type {ItemView,RunView} from '../../../packages/contracts/src/views.ts';

export type ToolState = NonNullable<ItemView['toolStatus']>;
export interface ToolActivity {item:ItemView;state:ToolState}
export const toolStates:Record<ToolState,string> = {inProgress:'执行中',completed:'已结束',failed:'失败',declined:'已拒绝',interrupted:'已中断',unknown:'结果未知'};
export function isToolItem(item:ItemView):boolean {return ['command','files','tool','agent'].includes(item.kind);}
/** An unfinished item can only be live in a fresh, active Run AND Turn. Never infer success from a Turn. */
export function toolActivities(run:RunView):ToolActivity[]{
  return (run.snapshot?.items??[]).filter(isToolItem).map(item=>{
    let state:ToolState=item.toolStatus??'unknown';
    if(state==='inProgress'&&(run.snapshot!.needsSnapshot||!['running','waiting_approval','waiting_input'].includes(run.status)||run.snapshot!.turns.find(t=>t.id===item.turnId)?.status!=='inProgress'))state='unknown';
    if(state==='completed'&&item.kind==='command'&&item.exitCode!==undefined&&item.exitCode!==0)state='failed';
    return{item,state};
  });
}
