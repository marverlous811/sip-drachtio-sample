import { DRACHTIO_CONFIG, MRF_CONFIG } from 'config'
import * as Srf from 'drachtio-srf'
import { registerParserMiddleware } from 'middlewares'
const TmpSrf = require('drachtio-srf')
const Mrf = require('drachtio-fsmrf')
// const Client = require('rtpengine-client').Client

const parseUri = TmpSrf.parseUri
const users = new Map()
let mediaserver: any

const srf = new Srf.default()
srf.connect(DRACHTIO_CONFIG)

srf.on('connect', (err, hostPort) => {
  if (!err) {
    console.log(`connected to drachtio listening on ${hostPort}`)
  } else {
    console.log(`error connecting to drachtio: `, err)
  }
})

const mrf = new Mrf(srf)
mrf
  .connect(MRF_CONFIG)
  .then((ms: any) => {
    console.log('connected to media server')
    mediaserver = ms
  })
  .catch((err: any) => {
    console.log(`Error connecting to media server: ${err}`)
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
    console.log(`registering ${uri.user}`)
    headers['Contact'] =
      `${req.get('Contact')};expires=${req.registration.expires || 300}`
  }

  res.send(200, {
    headers,
  })
})

srf.invite(async (req, res) => {
  const uri = parseUri(req.uri)
  // const from = req.get('From')
  const dest = users.get(uri.user)

  if (!dest) {
    return res.send(486, 'So sorry, busy right now', {})
  }

  res.send(180, 'ringing', {})
  try {
    let uasDialog: Srf.Dialog | undefined = undefined
    let uacDialog: Srf.Dialog | undefined = undefined
    //try to connect to callee
    console.log('create callee endpoint')
    const calleeEp = await mediaserver.createEndpoint()
    console.log('create uac')
    uacDialog = await srf.createUAC(
      dest,
      {
        localSdp: calleeEp.local.sdp,
      },
      {
        cbRequest: (uacReq) => {
          ;(req as any).on('cancel', () => {
            uacReq.cancel((() => {}) as any)
          })
        },
        cbProvisional: (uacRes) => {
          console.log(`got provisional response: ${uacRes.status}`)
        },
      },
    )
    console.log('modify sdp for uac')
    await calleeEp.modify(uacDialog.remote.sdp)

    uacDialog.on('destroy', () => {
      calleeEp.destroy()
      if (uasDialog) uasDialog.destroy()
    })

    //Try to send answer to caller
    console.log('create caller endpoint')
    const callerEp = await mediaserver.createEndpoint({
      remoteSdp: req.body,
    })
    console.log('create uas')
    uasDialog = await srf.createUAS(req, res, {
      localSdp: callerEp.local.sdp,
    })
    uacDialog.on('destroy', () => {
      callerEp.destroy()
      if (uasDialog) uasDialog.destroy()
    })
    console.log('caller ====> callee')
    await callerEp.bridge(calleeEp)
  } catch (err: any) {
    console.log(`Error connecting call: ${err}`)
    if (err.status) {
      console.log('Have error:', err.status, err.reason)
      return res.send(err.status, err.reason, {})
    }
    res.send(500)
  }
})

// srf.invite((req, res) => {
//   console.log(`received INVITE with `)
//   const callId = req.callId
// })
;(async () => {
  // const client = new Client()
  // console.log(client.ping)
  // const res = await client.ping(22222, '14.225.211.34')
  // console.log(res)
  // client
  //   .ping(22222, '14.225.211.34')
  //   .then((res: any) => {
  //     console.log(`received ${JSON.stringify(res)}`)
  //   })
  //   .error((err: any) => {
  //     console.log(`error `, err)
  //   })
})()