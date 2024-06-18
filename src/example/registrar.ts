export class Registrar {
  private _transactions: Map<string, any> = new Map()

  addTransaction(obj: any) {
    this._transactions.set(obj.aCallId, obj)
  }

  getNextCallIdAndCSeq(callId: string) {
    const obj = this._transactions.get(callId)
    if (obj) {
      const arr = /^(\d+)\s+(.*)$/.exec(obj.bCseq)
      if (arr) {
        obj.bCseq = ++(arr[1] as any) + ' ' + arr[2]
        return {
          'Call-Id': obj.bCallId,
          CSeq: obj.bCseq,
        }
      }
    }

    return undefined
  }

  hasTransaction(callId: string) {
    return this._transactions.has(callId)
  }

  removeTransaction(callId: string) {
    this._transactions.delete(callId)
  }
}
