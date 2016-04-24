var should = require('should');
var randomstring = require('randomstring');
var moment = require('moment');
var fs = require('fs');
var fspath = require('path');
var rotator = require('../lib/stream-rotate');
var fakeFS = require('mock-fs');
require('array.prototype.find').shim();

var isDebug = !! process.argv.find(function(element){return element==='-d';});

describe('Rotator', function(){

    var path = './log/';
    
    beforeEach(function(){
        resetDirectory(path);
    });
    
    afterEach(function(){
        resetDirectory(path);
    })
    

    it('should rotate on small file size', function(done){
        executeTest(this,3000,path,'size',1000,150,20,100,0,done);
    });
    
    it('should rotate on large size', function(done){
       executeTest(this,3000,path,'size',20000,5000,10,100,0,done); 
    });
    
    it('should only keep three files', function(done){
        executeTest(this,3000,path,'retention',300,75,20,3,0,done);
    });
    
    it('should rotate based on time');
    
    it('should rotate daily', function(done){
       executeTest(this,2000,path,'daily',300,50,10,100,86401,done); 
    });
    
    it('should rotate hourly', function(done){
       executeTest(this,2000,path,'hourly',2000,300,10,100,3601,done); 
    });
    
    it('should rotate minutely', function(done){
       executeTest(this,2000,path,'minutely',2000,300,3,100,61,done); 
    });
    
    it('should rotate secondly', function(done){
       executeTest(this,5000,path,'secondly',100000,300,200,100,2,done); 
    });

});

function executeTest(self,timeout,filepath,testType,testSize,bufferSize,iterations,retention,offset,done){
    self.timeout(timeout);
    var filebase = testType + '-rotator';
    var filename = fspath.join(filepath , filebase + '.log'); 
    var stat;
    fs.mkdirSync(filepath);
    fs.writeFileSync(filename, randomstring.generate(200));
    if(offset){
        stat = fs.statSync(filename);
        stat.mtime = new Date(stat.mtime.getTime()-(offset*1000));
        fs.utimesSync(filename,stat.mtime,stat.mtime);
    }
    var options = {
        path: filepath,
        name: filebase,
        retention: retention,
        size: testSize
    };
    if(testType==='daily' || testType==='hourly' || testType==='minutely' || testType==='secondly')
        options.boundary = testType;
    var r = new rotator(options);
    r.should.be.an.instanceof(rotator);
    
    if(isDebug){
        r.on('open', function(x){
        console.log('open:' + x); 
        });
        
        r.on('error', function(err){
            console.log(err);
        });
        r.on('drain', function(){
        console.log('DRAIN'); 
        });
        r.on('pipe', function(){
        console.log('PIPE'); 
        });
        r.on('close',function(){
            console.log("closed:" + filename);
        });
        r.on('rotated-on',function(x){
        console.log("rotated-on:" + x); 
        });
        r.on('rotated-off', function(f){
            var fstat = fs.statSync(f);
            console.log("rotated-off:" + f + ' ' + fstat.size + ' ' + moment(fstat.mtime).format()); 
        });
    }
    var ii = 0;
    var countWrites = 0;
    function work(){
        ii++;
        if(ii==iterations){            
            r.flush();
            r.on('close',function(){
                var results = analyzeFiles(filepath);
                results.maxSize.should.be.lessThan(testSize+1);
                var timeSpread = results.latest - results.earliest;
                var totalWriten = ( countWrites * bufferSize ) + 200;
                if(testType!=='retention')
                    totalWriten.should.equal(results.totalSize);
                if(testType==='retention')
                    results.totalCount.should.equal(retention + 1);
                if(testType==='daily')
                    timeSpread.should.be.greaterThan(86400000);
                if(testType==='hourly')
                    timeSpread.should.be.greaterThan(360000);
                if(testType==='minutely')
                    timeSpread.should.be.greaterThan(60000);
                if(testType==='secondly')
                    timeSpread.should.be.greaterThan(1000);                    
                return done();
            });
            r.close();
            return;
        }
        var rc = r.write(randomstring.generate(bufferSize));
        countWrites++;
        return setTimeout(work,2);
    }
    setTimeout(work,0);

}

function deleteFolderRecursive(path) {
    if( fs.existsSync(path) ) {
        fs.readdirSync(path).forEach(function(file,index){
            var curPath = fspath.join(path , file);
            if(fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
}

function analyzeFiles(path){
    var files = fs.readdirSync(path);
    var earliest = moment().add(1,'year');
    var latest = moment().subtract(1,'year');
    var stat;
    var minSize = 100000000;
    var maxSize = 0;
    var totalSize = 0;
    files.forEach(function(file){
        stat = fs.statSync(path+file);
        maxSize = Math.max(maxSize,stat.size);
        minSize = Math.min(minSize,stat.size);
        totalSize += stat.size;
        latest = Math.max(latest,moment(stat.mtime));
        earliest = Math.min(earliest,moment(stat.mtime));
    });
    return {
        earliest:earliest,
        latest:latest,
        minSize:minSize,
        maxSize:maxSize,
        totalSize:totalSize,
        totalCount:files.length
    };
}

function resetDirectory(filepath){
    if(isDebug)
        deleteFolderRecursive(filepath);
    else
        fakeFS({'.':{}});
}
