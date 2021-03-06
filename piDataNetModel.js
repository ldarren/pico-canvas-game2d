var
Abs = Math.abs,Floor=Math.floor,Random=Math.random,
API_ACK = 'ack',
PT_CHANNEL = 0,
PT_HEAD = 1,
PT_BODY = 2,
isOnline = true,
stdCB = function(err){if (err) console.error(err)},
appendFD = function(fd, name, value){ fd.append(name, value) },
appendObj = function(obj, name, value){ obj[name] = value },
timeSync = function(net, cb){
    cb = cb || stdCB
    pico.ajax('get', net.url, null, null, function(err, xhr){
        if (4 !== xhr.readyState) return
        if (err) return cb(err)
        var st = parseInt(xhr.responseText)
        if (isNaN(st)) return cb('invalid timesync response')
        net.serverTime = st
        net.serverTimeAtClient = Date.now()
        net.beatId = window.setInterval(onBeat, net.beatRate, net)
        cb()
    })
},
onResponse = function(err, xhr, net){
    if (err) {
        // network or auth error, return error to callbacks
        var
        reqs = net.reqs,
        sep = net.delimiter,
        reqId, cb, r
        for (var i=0,l=reqs.length,r; i<l; i++){
            r = reqs[i]
            if (!r) continue
            try{
                reqId = JSON.parse(r.split(sep)[0]).reqId
                cb = net.callbacks[reqId]
                if (!cb) continue
                delete net.callbacks[reqId]
                cb(err)
            }catch(exp){
                console.error(exp)
                continue
            }
        }
        reqs.length = 0
        return timeSync(net) // sync time, in case it was due to time error
    }

    // schedule next update
    switch(xhr.readyState){
    case 2: // send() and header received
        net.head = null
        net.currPT = PT_CHANNEL
        break
    case 3: break // body loading 
    case 4: // body received
        if (!net.beatId) net.beatId = window.setInterval(onBeat, net.beatRate, net)
        break
    }

    var
    startPos = net.resEndPos, endPos = -1,
    text = xhr.responseText,
    sep = net.delimiter,
    sepLen = sep.length,
    body = net.body,
    head

    try{
        while(true){
            endPos = text.indexOf(sep, startPos)
            if (-1 === endPos) break

            switch(net.currPT){
            case PT_CHANNEL:
                net.channel = text.substring(startPos, endPos)
                net.currPT = PT_HEAD
                break
            case PT_HEAD:
                net.head = JSON.parse(text.substring(startPos, endPos))
                body.length = 0
                net.currPT = PT_BODY
                break
            case PT_BODY:
                body.push(text.substring(startPos, endPos))
                break
            }
            head = net.head
            if (head && head.len === body.length){
                net.currPT = PT_HEAD

                if (head.resId){
                    net.request(API_ACK, {resId:head.resId})
                }
                if (!head.reqId) {
                    console.error('incomplete response header: '+JSON.stringify(head))
                    return 
                }
                if (net.cullAge && net.cullAge < Abs(net.getServerTime()-head.date)) {
                    console.error('invalid server time: '+JSON.stringify(head)+' '+Abs(net.getServerTime()-head.date))
                    return 
                }
                if (net.secretKey && body.length){
                    var hmac = CryptoJS.algo.HMAC.create(CryptoJS.algo.MD5, net.secretKey+head.date)

                    //key: CryptoJS.HmacMD5(JSON.stringify(data), this.secretKey+t).toString(CryptoJS.enc.Base64),
                    for(var i=0,l=body.length; i<l; i++){
                        hmac.update(body[i])
                    }

                    if (head.key !== hmac.finalize().toString(CryptoJS.enc.Base64)){
                        console.error('invalid server key: '+JSON.stringify(head))
                        return 
                    }
                }
                if (head.len)
                    head.data = JSON.parse(body[0], function(k, v){
                        switch(k){
                        case 'json': return JSON.parse(body[v])
                        case 'blob': return body[v]
                        default: return v
                        }
                    })
                net.inbox.push(head)
                net.head = null
            }

            startPos = endPos + sepLen
        }
    }catch(exp){
        // something is wrong
        console.error(exp)
    }
    net.resEndPos = startPos
},
onBeat = function(net){
    if (net.inbox.length){
        var
        inbox = net.inbox,
        callbacks = net.callbacks,
        reqId, cb

        for(var res; res=inbox.pop();){
console.debug('res: '+JSON.stringify(res))

            reqId = res.reqId
            cb = callbacks[reqId]
            if (cb){
                delete callbacks[reqId]
                cb(res.error, res.data)
            }
        }
    }

    // post update tasks, buffer data in memory network if offline
    if (isOnline && (net.uploads.length || net.outbox.length || net.acks.length)){

        net.resEndPos = 0

        if (net.uploads.length){
            var fb = net.uploads.shift()
            fb.append('channel', net.channel)
            pico.ajax('post', net.url, net.uploads.shift(), null, onResponse, net)
console.debug('reqs: upload')
        }else{
            var reqs = net.reqs = net.acks.concat(net.outbox)
            reqs.unshift(net.channel)
            net.acks.length = net.outbox.length = 0

            pico.ajax('post', net.url, reqs.join(net.delimiter)+net.delimiter, null, onResponse, net)
console.debug('reqs: '+reqs)
        }
        window.clearInterval(net.beatId)
        net.beatId = 0
        return
    }
},
formation = function(form, addon, dst, prefix){
    if (!form || !(form instanceof HTMLFormElement)) return
    prefix = prefix || ''

    var
    append = dst instanceof FormData ? appendFD : appendObj,
	uri = form.baseURI,
    fieldType, f, fl

    for (var i=0,elements = form.elements,field; field = elements[i]; i++) {
        if (!field.hasAttribute('name')) continue
        fieldType = field.hasAttribute('type') ? field.getAttribute('type').toUpperCase() : 'TEXT'
        if (fieldType === 'FILE') {
            for (f = 0, fl=field.files.length; f<fl; append(dst, prefix+field.name, field.files[f++]));
        } else if ((fieldType !== 'RADIO' && fieldType !== 'CHECKBOX') || field.checked) {
            append(dst, prefix+field.name, field.value)
        }//TODO: implement checkbox and radio
    }
    for (var k in addon) { append(dst, prefix+k, addon[k]) }

	uri = uri.substring(0, uri.lastIndexOf('/')+1)

    return form.action.substr(uri.length)
},
netConfig = function(net, cfg){
    net.url = cfg.url || net.url
    net.secretKey = cfg.secretKey || net.secretKey
    net.cullAge = cfg.cullAge || net.cullAge || 0
    net.delimiter = cfg.delimiter ? JSON.stringify(cfg.delimiter) : net.delimiter || JSON.stringify(['&'])
    net.beatRate = !cfg.beatRate || cfg.beatRate < 100 ? net.beatRate || 5000 : cfg.beatRate
},
netReset = function(net){
    net.resEndPos = net.outbox.length = net.acks.length = 0
    net.currPT = PT_CHANNEL
}

window.addEventListener('online', function(e){isOnline = true})
window.addEventListener('offline', function(e){isOnline = false})

function Net(cfg){
    if (!cfg.url){
        return console.error('url is not set')
    }
    netConfig(this, cfg)
    this.reqId = 1 + Floor(Random() * 1000)
    this.inbox = []
    this.outbox = []
    this.uploads = []
    this.callbacks = {}
    this.acks = []
    this.reqs = []
    this.resEndPos = 0
    this.channel = '',
    this.head = null,
    this.body = [],
    this.currPT = PT_CHANNEL,
    this.serverTime = 0
    this.serverTimeAtClient = 0
    this.beatId = 0
}

Net.prototype = {
    reconnect: function(cfg, cb){
        netConfig(this, cfg)
        netReset(this)
        timeSync(this, function(err){
            cb(err, this)
        })
    },
    submit: function(form, addon, cb){
        if (!form || !(form instanceof HTMLFormElement)) return console.error('No HTMLFormElement submitted')

        var reqId = 0

        if (cb){
            reqId = this.reqId++
            this.callbacks[reqId] = cb
        }

        var fd = new FormData()

        fd.append('api', formation(form, addon, fd, 'data/'))
        fd.append('reqId', reqId)

        this.uploads.push(fd)
        if (!this.beatId) this.beatId = window.setInterval(onBeat, this.beatRate, this)
    },
    // data: optional, usually api specific data
    // addon: optional, usually common data for every api
    // cb: optional, without cb, reqId will be 0
    request: function(api, data, addon, cb){
        switch(arguments.length){
        case 2:
            if (data instanceof Function){
                cb = data
                data = addon = undefined
            }
            break
        case 3:
            if (addon instanceof Function){
                cb = addon 
                addon = undefined
            }
            break
        case 4: break
        default: return console.error('wrong request params!')
        }
        if (data instanceof HTMLFormElement){
            var obj = {}
            api = formation(data, addon, obj)
            data = obj
        }else if(addon){
            for (var k in addon) { data[k] = addon[k] }
        }
        if (!api) return console.error('Missing api,  data['+JSON.stringify(data)+']')

        var queue = this.acks
        if (api !== API_ACK){
            queue = this.outbox
            if (queue.length){
                var lastReq = queue.shift()
                if (-1 === lastReq.indexOf(api)){
                    queue.unshift(lastReq)
                }
            }
        }

        var reqId = 0
        if (cb){
            reqId = this.reqId++
            this.callbacks[reqId] = cb
        }

        var dataList=[]

        if (data){
            dataList.unshift(JSON.stringify(data, function(k, v){
                switch(k){
                case 'json': return dataList.push(JSON.stringify(v))
                case 'blob': return dataList.push(v)
                default: return v
                }
            }))
        }

        if (dataList.length && this.secretKey){
            var
            t = this.getServerTime(),
            hmac = CryptoJS.algo.HMAC.create(CryptoJS.algo.MD5, this.secretKey+t)

            //key: CryptoJS.HmacMD5(JSON.stringify(data), this.secretKey+t).toString(CryptoJS.enc.Base64),
            for(var i=0,l=dataList.length; i<l; i++){
                hmac.update(dataList[i])
            }

            dataList.unshift(JSON.stringify({
                api: api,
                reqId: reqId,
                len:dataList.length,
                date: t,
                key: hmac.finalize().toString(CryptoJS.enc.Base64)
            }))
        }else{
            dataList.unshift(JSON.stringify({
                api: api,
                reqId: reqId,
                len:dataList.length
            }))
        }
        queue.push(dataList.join(this.delimiter))

        if (!this.beatId) this.beatId = window.setInterval(onBeat, this.beatRate, this)
    },
    getServerTime: function(){
        return this.serverTime + (Date.now() - this.serverTimeAtClient)
    }
}

me.create = function(cfg, cb){
    var net = new Net(cfg)
    timeSync(net, function(err){
        cb(err, net)
    })
}
