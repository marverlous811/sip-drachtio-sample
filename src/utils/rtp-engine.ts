export function removeWebrtcAttributes(sdp: string) {
  if (!sdp.includes('a=ssrc')) {
    return sdp
  }
  let sdpArray = sdp.split(/\r\n/)
  sdpArray = sdpArray.filter(
    (attribute) =>
      !attribute.includes('a=ssrc') && !attribute.includes('a=msid'),
  )
  return sdpArray.join('\r\n')
}

export function makeRtpOpts(
  callId: string,
  fromTag: string,
  srcIsUsingSrtp?: boolean,
  dstIsUsingSrtp?: boolean,
): any {
  const common = {
    'call-id': callId,
    replace: ['origin', 'session-connection'],
  }
  const srtpCharacteristics = {
    'transport-protocol': 'UDP/TLS/RTP/SAVPF',
    ICE: 'force',
    'rtcp-mux': ['require'],
    flags: ['SDES-no', 'generate mid'],
  }

  const rtpCharacteristics = {
    'transport protocol': 'RTP/AVP',
    DTLS: 'off',
    ICE: 'remove',
    'rtcp-mux': ['demux'],
    flags: ['SDES-no'],
  }
  const dstOpts = dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics
  const srctOpts = srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics
  const callDirection = srcIsUsingSrtp ? 'outbound' : 'inbound'

  return {
    common,
    uas: {
      tag: fromTag,
      mediaOpts: srctOpts,
    },
    uac: {
      tag: null,
      mediaOpts: dstOpts,
    },
    callDirection,
  }
}
