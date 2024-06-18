// const Client = require('rtpengine-client').Client

import { initFreeswitch } from 'example/freeswitch'
import { initWithRtpEngine } from 'example/rtp_engine'
;(async () => {
  initWithRtpEngine()
  // initFreeswitch()
})()
