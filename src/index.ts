// const Client = require('rtpengine-client').Client

import { initFreeswitch } from 'example/freeswitch'
import { initWithRtpEngine } from 'example/rtp_engine'
import { simpleRtp } from 'example/simple-rtp'
;(async () => {
  // initWithRtpEngine()
  // initFreeswitch()
  simpleRtp()
})()
