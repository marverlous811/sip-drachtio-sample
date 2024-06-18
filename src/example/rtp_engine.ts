import { DRACHTIO_CONFIG, RTP_ENGINE_CONFIG } from 'config'
import * as Srf from 'drachtio-srf'
import { registerParserMiddleware } from 'middlewares'
import { makeRtpOpts, removeWebrtcAttributes } from 'utils'
import { Registrar } from './registrar'
const TmpSrf = require('drachtio-srf')
const SipError = require('drachtio-srf').SipError
const Client = require('rtpengine-client').Client
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
export function initWithRtpEngine() {
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
  start(srf, rtpEngineCli, registrar)
}

function start(srf: any, rtpEngine: any, registrar: any) {
  const offer = rtpEngine.offer.bind(rtpEngine, RTP_ENGINE_CONFIG)
  const answer = rtpEngine.answer.bind(rtpEngine, RTP_ENGINE_CONFIG)
  const del = rtpEngine.delete.bind(rtpEngine, RTP_ENGINE_CONFIG)

  srf.invite(async (req: any, res: any) => {
    console.log(
      `received invite from ${req.protocol}/${req.source_address}:${req.uri} with request uri ${req.uri}`,
    )

    // determine whether this is a call from or to a webrtc client
    const callid = req.get('Call-Id')
    const from = req.getParsedHeader('From')
    let remoteUri = req.uri
    let callDirection = 'outbound'
    const parsedUri = parseUri(req.uri)
    const user = parsedUri.user
    const trunk = parsedUri.host
    const callTag = (from.params as any).tag
    const rtpEngineIdentifyingDetails = {
      'call-id': callid,
      'from-tag': callTag,
    }
    let inviteSent: any

    if (users.has(user)) {
      const details = users.get(user)
      remoteUri = details
      callDirection = 'inbound'
      console.log(`inbound call with details: ${details}}`)
    }

    const rtpEngineOpts = makeRtpOpts(
      callid,
      callTag,
      'outbound' === callDirection,
      'inbound' === callDirection,
    )
    const optsOffer = {
      ...rtpEngineOpts.common,
      ...rtpEngineOpts.uac.mediaOpts,
      'from-tag': rtpEngineOpts.uas.tag,
      sdp: req.body,
    }

    try {
      const response = await offer(optsOffer)
      console.log('initial offer to rtpengine', { offer: optsOffer, response })
      if ('ok' !== response.result) {
        throw new Error(
          `failed allocating endpoint from rtpengine: ${JSON.stringify(response)}`,
        )
      }

      if ('outbound' === callDirection) {
        response.sdp = removeWebrtcAttributes(response.sdp)
      }

      const opts = createHeader(response.sdp, callid)
      const sdpGenerator = produceUacSdp.bind(null, answer, rtpEngineOpts)
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

      console.log(`sending INVITE to B with ${JSON.stringify(callOpts)}`)
      const { uas, uac } = await srf.createB2BUA(
        req,
        res,
        remoteUri,
        callOpts,
        {
          cbRequest: (err: any, req: any) => (inviteSent = req),
        },
      )

      rtpEngineOpts.uac.tag = uac.sip.remoteTag
      const key = makeReplacesStr(uas)
      const value = makeReplacesStr(uac)
      calls.set(key, value)
      console.log(
        `after adding call there are now ${calls.size} calls in progress`,
      )

      uas.on(
        'destroy',
        _onDestroy.bind(
          null,
          uas,
          uac,
          calls.delete.bind(calls, key),
          deleteProxy.bind(null, del, rtpEngineIdentifyingDetails),
        ),
      )
      uac.on(
        'destroy',
        _onDestroy.bind(
          null,
          uac,
          uas,
          calls.delete.bind(calls, key),
          deleteProxy.bind(null, del, rtpEngineIdentifyingDetails),
        ),
      )

      // uas.on('refer', this._handleRefer.bind(this, uas, uac))
      // uac.on('refer', this._handleRefer.bind(this, uac, uas))

      // uas.on('info', this._handleInfo.bind(this, uas, uac))
      // uac.on('info', this._handleInfo.bind(this, uac, uas))

      uas.on(
        'modify',
        _handleReinvite.bind(null, uas, offer, answer, rtpEngineOpts),
      )
      uac.on(
        'modify',
        _handleReinvite.bind(null, uac, offer, answer, rtpEngineOpts),
      )
    } catch (err: any) {
      deleteProxy(del, rtpEngineIdentifyingDetails)
      if (err instanceof SipError && [401, 407].includes(err.status)) {
        console.log(`invite challenged with ${err.status}`)
        registrar.addTransaction({
          aCallId: callid,
          bCallId: inviteSent.get('Call-Id'),
          bCseq: inviteSent.get('CSeq'),
        })
      } else if (487 === err.status) {
        console.log('caller hung up')
      } else {
        console.log(`Error connecting call: ${err}`)
      }
    }
  })
}

function _onDestroy(
  dlg: any,
  dlgOther: any,
  fnDeleteCall: any,
  fnDeleteProxy: any,
) {
  dlgOther.destroy()
  fnDeleteCall()
  fnDeleteProxy()
  console.log(
    `after hanging up call there are now ${calls.size} calls in progress`,
  )
}

async function _handleReinvite(
  dlg: any,
  offer: any,
  answer: any,
  rtpEngineOpts: any,
  req: any,
  res: any,
) {
  console.log(`received reinvite on ${dlg.type} leg`, {
    rtpEngineOpts: dlg.rtpEngineOpts,
    sdp: req.body,
  })

  try {
    const offerMedia =
      dlg.type === 'uas'
        ? rtpEngineOpts.uac.mediaOpts
        : rtpEngineOpts.uas.mediaOpts
    const answerMedia =
      dlg.type === 'uas'
        ? rtpEngineOpts.uas.mediaOpts
        : rtpEngineOpts.uac.mediaOpts
    let fromTag = dlg.other.sip.localTag
    let toTag = dlg.other.sip.remoteTag
    if (dlg.type === 'uac') {
      fromTag = dlg.sip.remoteTag
      toTag = dlg.sip.localTag
    }
    const optsOffer = {
      ...rtpEngineOpts.common,
      ...offerMedia,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp: req.body,
    }
    let response = await offer(optsOffer)
    if ('ok' !== response.result) {
      res.send(488)
      throw new Error(
        `_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`,
      )
    }
    console.log('sent offer for reinvite to rtpengine', { optsOffer, response })

    if (JSON.stringify(offerMedia).includes('ICE":"remove')) {
      response.sdp = removeWebrtcAttributes(response.sdp)
    }

    let optsSdp
    let ackFunc
    if (!req.body) {
      //handle late offer reInvite by not letting the ACK be generated until we receive the sender's ACK with sdp.
      const { sdp, ack } = await dlg.other.modify(response.sdp, { noAck: true })
      optsSdp = sdp
      ackFunc = ack
    } else {
      const sdp = await dlg.other.modify(response.sdp)
      optsSdp = sdp
    }

    const optsAnswer = {
      ...rtpEngineOpts.common,
      ...answerMedia,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp: optsSdp,
    }
    response = await answer(optsAnswer)
    if ('ok' !== response.result) {
      res.send(488)
      throw new Error(
        `_onReinvite: rtpengine failed: ${JSON.stringify(response)}`,
      )
    }
    console.log('sent answer for reinvite to rtpengine', {
      optsAnswer,
      response,
    })
    if (JSON.stringify(answerMedia).includes('ICE":"remove')) {
      response.sdp = removeWebrtcAttributes(response.sdp)
    }
    res.send(200, { body: response.sdp })

    // if (!req.body && !dlg.hasAckListener) {
    //   // set listener for ACK, so that we can use that SDP to create the ACK for the other leg.
    //   dlg.once(
    //     'ack',
    //     _handleAck.bind(
    //       null,
    //       dlg,
    //       answer,
    //       offer,
    //       ackFunc,
    //       optsSdp,
    //       rtpEngineOpts,
    //     ),
    //   )
    // }
  } catch (err) {
    console.log('Error handling reinvite', err)
  }
}

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
  console.log('produceUacSdp', opts)
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
      console.log(`response from rtpEngine#answer: ${JSON.stringify(response)}`)
      return response.sdp
    })
}

const deleteProxy = (del: any, rtpEngineIdentifyingDetails: any) => {
  del(rtpEngineIdentifyingDetails)
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
