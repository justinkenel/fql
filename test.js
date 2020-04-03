const {parse,toSql,withAnalysis}=require('./index.js');
const assert=require('assert');

function assertParse(x,expected) {
	it('should parse `'+x+'`', () => {
		const parsed=parse(x);
		const back=toSql({
			fieldFn: (f => f),
			tableFn: (f => f),
			valueFn: (f => {
				if(f == parseInt(f)) return f;
				return `"${f}"`;
			}),
			functions: {concat:1,sum:1,count:1}
		},parsed);
		assert.equal(back,expected);
	});
}

function roundTrip(x,expected) {
	it('should parse `'+x+'`', () => {
		const parsed=parse(x);
		const back=toSql({
			fieldFn: (f => f),
			tableFn: (f => f),
			valueFn: (f => {
				if(f == parseInt(f)) return f;
				return `"${f}"`;
			}),
			functions: {concat:1,sum:1,count:1}
		},parsed);
		assert.equal(back,expected);
	});

	it('should parse `'+x+'` to same structure', () => {
		const parsed=parse(x);
		const back=toSql({
			fieldFn: (f => f),
			tableFn: (f => f),
			valueFn: (f => {
				if(f == parseInt(f)) return f;
				return `"${f}"`;
			}),
			functions: {concat:1,sum:1,count:1}
		},parsed);
		const backParsed = parse(back);
		assert.deepEqual(backParsed, parsed);
	});
}

describe('roundTrip toSql(parse(x))', ()=> {
	roundTrip('concat("test",x)',	'concat("test", x)');
	roundTrip('sum(total)/count(*)', '(sum(total) / count(*))');
	roundTrip('test1.x + test2.y * 2', '(test1.x + (test2.y * 2))');
	roundTrip('(test1.x + test2.y) * 2', '((test1.x + test2.y) * 2)');
	roundTrip('(test1.x + test2.y / 2) * 2', '((test1.x + (test2.y / 2)) * 2)');

	roundTrip('not 1', '(not 1)');
	roundTrip('x and y and not z', '((x and y) and (not z))');

	roundTrip('x between 1 and 2', '(x between 1 and 2)');
	roundTrip('x between 1+3 and 2/x', '(x between (1 + 3) and (2 / x))');

	roundTrip('1 in (x,y,4,5,x*3)', '(1 in (x, y, 4, 5, (x * 3)))');
	roundTrip('1 not in (x,y,4,5,x*3)', '(1 not in (x, y, 4, 5, (x * 3)))');
	roundTrip('concat("test",2)','concat("test", 2)');

	roundTrip(`case when x=1 then "test" else "hello" end`, '(case when (x = 1) then "test" else "hello" end)');

	roundTrip(`date_add("2019-01-01", interval 1 day)`, `date_add("2019-01-01", interval 1 day)`);
	roundTrip(`date_add(x, interval y day)`, `date_add(x, interval y day)`);
	roundTrip(`1.0 + 0.3`, `(1 + 0.3)`);

	roundTrip(`cast(x as char)`,`cast(x as char)`);
	roundTrip(`cast(x as signed)`,`cast(x as signed)`);

	// object literals
	roundTrip(`if(1=1,null,1)`,`if((1 = 1), null, 1)`);
	roundTrip(`if(1=1,true,1)`,`if((1 = 1), true, 1)`);
	roundTrip(`if(1=1,false,1)`,`if((1 = 1), false, 1)`);

	roundTrip(`date_add(now(), interval 1 day)`,'date_add(now(), interval 1 day)');
	roundTrip(`date_sub(now(), interval 1 day)`,'date_sub(now(), interval 1 day)');
	roundTrip(`now() + interval 1 day`,'date_add(now(), interval 1 day)');
	roundTrip(`now() - interval 1 day`,'date_sub(now(), interval 1 day)');
	roundTrip('now()', 'now()');
	roundTrip('getdate()', 'now()');
	roundTrip('distinct x', 'distinct x');

	roundTrip('x < y', '(x < y)');

	roundTrip(
		`case when a<=20 then '$0-$20'
			when a>20 and a<=50  then '$20-$50'
			when a>50 then '$50+' end`
		, `(case when (a <= 20) then "$0-$20" `+
			`when ((a > 20) and (a <= 50)) then "$20-$50" `+
			`when (a > 50) then "$50+"  end)`);

	roundTrip(`case x when 1 then "one" when 2 then "two" else "other" end`,
		'(case x when 1 then "one" when 2 then "two" else "other" end)');

	roundTrip('if(x,y,z)', 'if(x, y, z)',);

	roundTrip('if(y,1+1,x)', 'if(y, (1 + 1), x)');
	roundTrip('"test" like "t%1"', '("test" like "t%1")');
	roundTrip('"test" not like "t%1"', '("test" not like "t%1")');
	roundTrip('if(true, null, false)', 'if(true, null, false)');
	roundTrip('x is null', '(x is null)');
	roundTrip('x is not null', '(x is not null)');

	roundTrip('x + null', '(x + null)');
});

describe('ifnull', () => {
	assertParse('ifnull(x,y)', 'case when x is not null then x else y end');
	assertParse('ifnull(x,y,z)',
		'case when x is not null then x '+
		'when y is not null then y else z end');
	assertParse('ifnull(x,1+y,2+z)',
		'case when x is not null then x '+
		'when (1 + y) is not null then (1 + y) else (2 + z) end');
});

function testAnalysis(baseTable,text,expected) {
	it('should correctly analyze `'+text+'`', () => {
		const result = withAnalysis({
			text,baseTable,

			fieldFn: (f => f),
			tableFn: (f => f),
			valueFn: (f => {
				if(f == parseInt(f)) return f;
				return `"${f}"`;
			}),
			functions: {concat:1,sum:1,count:1}
		});

		delete result.getEvalFn;

		assert.deepEqual(result, expected);
	});
}

describe('withAnalysis(x)', ()=> {
	testAnalysis('test','1+1',{
		cleaned: '(1 + 1)',
		refsByTable: {}
	});
	testAnalysis('test','x+1',{
		cleaned: '(test.x + 1)',
		refsByTable: {test: {x:1}}
	});
	testAnalysis('test1','x+test2.y',{
		cleaned: '(test1.x + test2.y)',
		refsByTable: {test1: {x:1}, test2:{y:1}}
	});
	testAnalysis('t', 'if(x,y+1,test.z)', {
		cleaned: 'if(t.x, (t.y + 1), test.z)',
		refsByTable: {t: {x:1,y:1}, test:{z:1}}
	});
});
