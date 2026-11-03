import type {ExecutionLedger} from '../../store/src/ledger.ts';
/** Deterministic local projection consumer. It never dispatches models, tools or external actions. */
export class OutboxPump {
 private store:ExecutionLedger;
 constructor(store:ExecutionLedger){this.store=store;}
 step(limit=50):{claimed:number;projected:number;retried:number}{
  const batch=this.store.claimOutbox(limit);let projected=0,retried=0;
  for(const claim of batch){try{if(this.store.deliverOutbox(claim))projected++;}catch{this.store.retryOutbox(claim);retried++;}}
  return{claimed:batch.length,projected,retried};
 }
}
