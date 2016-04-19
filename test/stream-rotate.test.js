var should = require('should');
var randomstring = require('randomstring');
var moment = require('moment');
var fs = require('fs');
var rotator = require('../lib/stream-rotate');

describe('Rotator', function(){

    it('should rotate on small file size', function(done){
        executeTest(this,3000,'./log/','size',1000,150,20,100,done);
    });
    
    it('should rotate on large size', function(done){
       executeTest(this,3000,'./log/','size',20000,5000,10,100,done); 
    });
    
    it('should only keep three files', function(done){
        executeTest(this,3000,'./log/','retention',300,75,20,3,done);
    })

});

function executeTest(self,timeout,filepath,testType,testSize,bufferSize,iterations,retention,done){
    self.timeout(timeout);
    var filebase = testType + '-rotator';
    var filename = filepath + filebase + '.log'; 
    var stat;
    deleteFolderRecursive(filepath);
    fs.mkdirSync(filepath);
    fs.writeFileSync(filename, randomstring.generate(200));
    var r = new rotator({
        path: filepath,
        name: filebase,
        retention: retention,
        size: testSize
    });
    r.should.be.an.instanceof(rotator);
    r.error = function(err){
        console.log("ERROR:" + JSON.stringify(err));
    };
    var ii = 0;
    var countWrites = 0;
    function work(){
        while(true){
            ii++;
            if(ii>iterations){
                var files = fs.readdirSync(filepath);
                var fileSizes = 0;
                files.forEach(function(element) {
                    var stat = fs.statSync(filepath + element);
                    stat.size.should.be.lessThan(testSize+1);
                    fileSizes += stat.size;
                }, this);
                var totalWriten = ( countWrites * bufferSize ) + 200;
                if(testType==='size')
                    totalWriten.should.equal(fileSizes);
                if(testType==='retention')
                    files.length == retention + 1;
                return done();
            }
            var rc = r.write(randomstring.generate(bufferSize));
            countWrites++;
            return setTimeout(work,10);
        }
    }
    setTimeout(work,10);

}

function deleteFolderRecursive(path) {
    if( fs.existsSync(path) ) {
        fs.readdirSync(path).forEach(function(file,index){
            var curPath = path + "/" + file;
            if(fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
}
