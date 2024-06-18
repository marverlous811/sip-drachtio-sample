import { DRACHTIO_CONFIG, RTP_ENGINE_CONFIG } from 'config'
import * as Srf from 'drachtio-srf'
import { registerParserMiddleware } from 'middlewares'
import { makeRtpOpts, removeWebrtcAttributes } from 'utils'
import { Registrar } from './registrar'
const TmpSrf = require('drachtio-srf')
const SipError = require('drachtio-srf').SipError
const Client = require('rtpengine-client').Client
export function initWithRtpEngine() {
  const parseUri = TmpSrf.parseUri
  const users = new Map()
  const rtpEngineCli = new Client(RTP_ENGINE_CONFIG)
  const registrar = new Registrar()
  const calls: Map<any, any> = new Map()

  const srf = new Srf.default()
  srf.connect(DRACHTIO_CONFIG)
  srf.on('connect', (err, hostPort) => {
    if (!err) {
      console.log(`connected to drachtio listening on ${hostPort}`)
    } else {
      console.log(`error connecting to drachtio: `, err)
    }
  })
  ;(srf as any).register(registerParserMiddleware, (req: any, res: any) => {
    const uri = parseUri(req.registration.aor)
    const headers: any = {}
    if (req.registration.type === 'unregister') {
      console.log(`unregistering ${uri.user}`)
      users.delete(uri.user)
    } else {
      const contact = req.registration.contact[0].uri
      users.set(uri.user, contact)
      console.log(`registering ${uri.user}`, contact)
      headers['Contact'] =
        `${req.get('Contact')};expires=${req.registration.expires || 300}`
    }

    res.send(200, {
      headers,
    })
  })

  srf.invite(async (req, res) => {
    const callId = req.get('Call-ID')
    const from = req.getParsedHeader('from')
    let remoteUri = req.uri
    const parsedUri = parseUri(remoteUri)
    const user = parsedUri.user
    const trunk = parseUri.host
    const callTag = (from.params as any).tag

    console.log(`received call from ${from.uri} to ${remoteUri}`, from, callId)
    console.log(`user: ${user}, trunk: ${trunk}`, parsedUri)

    const rtpEngineIdentity = {
      'call-id': callId,
      'from-tag': callTag,
    }
    let callDirection = 'outbound'
    let inviteSent: any

    const dest = users.get(user)
    if (dest) {
      callDirection = 'inbound'
      remoteUri = dest
    }

    const rtpEngineOpts = makeRtpOpts(
      callId,
      callTag,
      'outbound' === callDirection,
      'inbound' === callDirection,
    )

    const offerOpts = {
      ...rtpEngineOpts.common,
      ...rtpEngineOpts.uac.mediaOpts,
      'from-tag': callTag,
      sdp: req.body,
    }

    try {
      const offerRes: { sdp: string; result: string } =
        await rtpEngineCli.offer(
          RTP_ENGINE_CONFIG.port,
          RTP_ENGINE_CONFIG.host,
          offerOpts,
        )

      console.log(`rtpengine offer: ${JSON.stringify(offerRes)}`)
      if (offerRes.result !== 'ok') {
        return res.send(500)
      }

      const opts = createHeader(callId, offerRes.sdp)
      const sdpGenerator = produceUacSdp.bind(null, opts, offerRes.sdp)
      const callOpts = {
        headers: opts.headers,
        localSdpA: sdpGenerator,
        localSdpB: opts.sdp,
        proxyRequestHeaders: [
          'from',
          'to',
          'proxy-authorization',
          'authorization',
          'supported',
          'allow',
          'content-type',
          'user-agent',
          'Diversion',
          'X-Connect-Info',
        ],
        proxyResponseHeaders: [
          'proxy-authenticate',
          'www-authenticate',
          'accept',
          'allow',
          'allow-events',
        ],
      }
      const { uas, uac } = await srf.createB2BUA(
        req,
        res,
        remoteUri,
        callOpts,
        {
          cbRequest: ((err: any, req: any) => (inviteSent = req)) as any,
        },
      )

      rtpEngineOpts.uac.tag = uac.sip.remoteTag
      const key = makeReplacesStr(uas)
      const value = makeReplacesStr(uac)
      calls.set(key, value)

      uac.on(
        'destroy',
        _onDestroy.bind(
          null,
          uac,
          uas,
          calls.delete.bind(calls, key),
          deleteProxy.bind(null, rtpEngineIdentity),
        ),
      )
      uas.on(
        'destroy',
        _onDestroy.bind(
          null,
          uas,
          uac,
          calls.delete.bind(calls, key),
          deleteProxy.bind(null, rtpEngineIdentity),
        ),
      )

      uas.on('modify', _handleReinvite.bind(null, uas, rtpEngineOpts))
      uac.on('modify', _handleReinvite.bind(null, uac, rtpEngineOpts))
    } catch (err: any) {
      deleteProxy(rtpEngineIdentity)
      if (err instanceof SipError && [401, 407].includes(err.status)) {
        console.log(`invite challenged with ${err.status}`)
        registrar.addTransaction({
          aCallId: callId,
          bCallId: inviteSent.get('Call-Id'),
          bCseq: inviteSent.get('CSeq'),
        })
        return res.send(err.status)
      } else if (487 === err.status) {
        console.log('caller hung up')
      } else {
        console.log(`Error connecting call: ${err}`)
      }
    }
  })

  const createHeader = (callId: string, sdp: string) => {
    // check if we have a call-id / cseq that we used previously on a 407-challenged INVITE
    const headers = {}
    const obj = registrar.getNextCallIdAndCSeq(callId)
    if (obj) {
      Object.assign(headers, obj)
      registrar.removeTransaction(callId)
    } else {
      Object.assign(headers, { CSeq: '1 INVITE' })
    }
    return { headers, sdp }
  }

  const produceUacSdp = (opts: any, remoteSdp: string) => {
    if (opts.callDirection === 'inbound') {
      remoteSdp = removeWebrtcAttributes(remoteSdp)
    }

    Object.assign(opts, {
      sdp: remoteSdp,
      ...opts.common,
      ...opts.uas.mediaOpts,
      'from-tag': opts.uas.tag,
    })

    return rtpEngineCli
      .answer(RTP_ENGINE_CONFIG.port, RTP_ENGINE_CONFIG.host, opts)
      .then((response: any) => {
        console.log(
          `response from rtpEngine#answer: ${JSON.stringify(response)}`,
        )
        return response.sdp
      })
  }

  const deleteProxy = (rtpEngineIdentifyingDetails: any) => {
    rtpEngineCli.delete(
      RTP_ENGINE_CONFIG.port,
      RTP_ENGINE_CONFIG.host,
      rtpEngineIdentifyingDetails,
    )
  }

  function makeReplacesStr(dlg: Srf.Dialog) {
    let s = ''
    if (dlg.type === 'uas') {
      s = encodeURIComponent(
        `${dlg.sip.callId};to-tag=${dlg.sip.localTag};from-tag=${dlg.sip.remoteTag}`,
      )
    } else {
      s = encodeURIComponent(
        `${dlg.sip.callId};to-tag=${dlg.sip.remoteTag};from-tag=${dlg.sip.localTag}`,
      )
    }
    return s
  }

  const _onDestroy = (
    dlg: Srf.Dialog,
    otherDlg: Srf.Dialog,
    fnDeleteCall: any,
    fnDeleteProxy: any,
  ) => {
    otherDlg.destroy()
    fnDeleteCall()
    fnDeleteProxy()
  }

  const _handleReinvite = async (
    dlg: Srf.Dialog,
    opts: any,
    req: any,
    res: any,
  ) => {
    try {
      const offerMedia =
        dlg.type === 'uas' ? opts.uac.mediaOpts : opts.uas.mediaOpts
      const answerMedia =
        dlg.type === 'uas' ? opts.uas.mediaOpts : opts.uac.mediaOpts
      const fromTag =
        dlg.type === 'uac' ? dlg.other.sip.localTag : dlg.sip.remoteTag
      const toTag =
        dlg.type === 'uac' ? dlg.other.sip.remoteTag : dlg.sip.localTag

      const offerOpts = {
        ...opts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp: req.body,
      }
      let response = await rtpEngineCli.offer(
        RTP_ENGINE_CONFIG.port,
        RTP_ENGINE_CONFIG.host,
        offerOpts,
      )
      if ('ok' !== response.result) {
        res.send(488)
        throw new Error(
          `_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`,
        )
      }

      if (JSON.stringify(offerMedia).includes('ICE":"remove')) {
        response.sdp = removeWebrtcAttributes(response.sdp)
      }
      let optsSdp
      let ackFunc
      if (!req.body) {
        //handle late offer reInvite by not letting the ACK be generated until we receive the sender's ACK with sdp.

        const { sdp, ack } = await (dlg.other.modify as any)(response.sdp, {
          noAck: true,
        })
        optsSdp = sdp
        ackFunc = ack
      } else {
        const sdp = await dlg.other.modify(response.sdp)
        optsSdp = sdp
      }

      const answerOpts = {
        ...opts.common,
        ...answerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp: optsSdp,
      }
      response = await rtpEngineCli.answer(
        RTP_ENGINE_CONFIG.port,
        RTP_ENGINE_CONFIG.host,
        answerOpts,
      )
      if ('ok' !== response.result) {
        res.send(488)
        throw new Error(
          `_onReinvite: rtpengine failed: ${JSON.stringify(response)}`,
        )
      }

      if (JSON.stringify(answerMedia).includes('ICE":"remove')) {
        response.sdp = removeWebrtcAttributes(response.sdp)
      }
      res.send(200, { body: response.sdp })
    } catch (e) {
      console.log('Error handling reinvite', e)
    }
  }
}
