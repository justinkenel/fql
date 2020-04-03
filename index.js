const nearley = require('nearley');
const grammar = require('./fql-parse');
const debug = require("debug")("fql");

function parse(sql) {
	sql=sql.trim();
	const parser = new nearley.Parser(grammar.ParserRules, grammar.ParserStart);
	const parsed = parser.feed(sql);
	// console.log(JSON.stringify(parsed.results[0],null,2));
	if(parsed.length > 1) throw new Error('invalid - ambiguous');
	return parsed.results[0];
}

function walkNodes(options,parsed) {
	const{handlers}=options;
	if(!handlers) throw new Error('Handlers is required');
	function internal(node) {
		if(!node) return '';
		const{type}=node;
		const handler = handlers[type];
		if(!handler){
		// eslint-disable-next-line no-console
			console.error('invalid node:',JSON.stringify(node,null,2));
			throw new Error('invalid type: '+type);
		}
		return handler(node, Object.assign(options,{internal}));
	}
	return internal(parsed);
}
const toSqlHandlers = {
	'column': (node,{tableFn,fieldFn, defaultTable}) => {
		const{table=defaultTable,name}=node;
		if(table) return `${tableFn(table)}.${fieldFn(name)}`;
		return fieldFn(name);
	},
	'operator': (node,{internal}) => {
		const{left,right,operator}=node;
		const lExpr=internal(left);
		const rExpr=internal(right);
		return `(${lExpr} ${operator} ${rExpr})`;
	},
	'not': (node,{internal}) => {
		const {operand}=node;
		const expr=internal(operand);
		return `(not ${expr})`;
	},
	'decimal': (node) => {
		return parseFloat(node.value);
	},
	'string': (node,{valueFn}) => {
		return valueFn(node.string);
	},
	'identifier': (node,fieldFn) => {
		return fieldFn(node.value);
	},
	'distinct': ({operand}, {internal}) => {
		return `distinct ${internal(operand)}`;
	},
	'ifnull': (node, {internal}) => {
		const {value,rest}=node;
		const list = [value].concat(rest.exprs || rest);
		const final = list[list.length-1];
		const checks = list.slice(0,-1);
		return [
			`case`,
			checks.map(x => {
				const r = internal(x);
				return `when ${r} is not null then ${r}`;
			}).join(' '),
			`else ${internal(final)} end`
		].join(' ');
	},
	'date_expr': (node, {date_expr,internal}) => {
		const {operator,left_side,interval}=node;
		if(date_expr) return date_expr(node);
		let fn = 'date_add';
		if(operator == '-') fn = 'date_sub';
		const {value,unit}=interval;
		return `${fn}(${internal(left_side)}, interval ${internal(value)} ${unit})`;
	},
	'now': () => {
		return 'now()';
	},
	'function_call': (node, {internal,functions}) => {
		let{name,parameters,select_all=false}=node;
		name = (name.value||'').toLowerCase();
		// if(!functions[name]) throw new Error('invalid function: '+name);

		let pExprs;
		if(!select_all) pExprs = parameters.map(internal);
		else pExprs = ['*'];

		if(typeof functions[name] != 'function') return `${name}(${pExprs.join(', ')})`;
		return functions[name](pExprs);
	},
	'between': (node,{internal}) => {
		let{value,lower,upper,not}=node;

		const vExpr=internal(value);
		const lExpr=internal(lower);
		const uExpr=internal(upper);

		let notExpr = '';
		if(not) notExpr = 'not ';

		let base=`(${vExpr} ${notExpr}between ${lExpr} and ${uExpr})`;
		return base;
	},
	'in': (node,{internal}) => {
		const {value,not,exprs}=node;

		const vExpr=internal(value);
		const eExprs=exprs.map(internal);

		let notExpr = '';
		if(not) notExpr = 'not ';

		return `(${vExpr} ${notExpr}in (${eExprs.join(', ')}))`;
	},
	'case': (node,{internal}) => {
		const {match,when_statements,else:elseStatement} = node;

		const wExprs = when_statements.map(internal);
		const elseExpr = elseStatement && internal(elseStatement);

		let mExpr=' ';
		if(match) mExpr=' '+internal(match)+' ';
		let out=`(case${mExpr}`+wExprs.join(' ')+` ${elseExpr?"else "+elseExpr:""} end)`;
		debug("CASE statement resolved to:",out);
		return out;
	},
	'when': (node,{internal}) => {
		const {condition,then}=node;

		const cExpr=internal(condition);
		const tExpr=internal(then);

		return `when ${cExpr} then ${tExpr}`;
	},
	'if': (node,{internal}) => {
		const {condition,then,else:elseStatement}=node;

		const cExpr=internal(condition);
		const tExpr=internal(then);
		const eExpr=internal(elseStatement);

		return `if(${cExpr}, ${tExpr}, ${eExpr})`;
	},
	'like': (node,{internal}) => {
		const{not,value,comparison}=node;

		const vExpr=internal(value);
		const cExpr=internal(comparison);

		let notExpr = '';
		if(not) notExpr = 'not ';

		return `(${vExpr} ${notExpr}like ${cExpr})`;
	},
	'true': () => {
		return 'true';
	},
	'false': () => {
		return 'false';
	},
	'null': () => {
		return 'null';
	},
	'is_null': (node,{internal}) => {
		const {value,not}=node;
		let notExpr = '';
		if(not) notExpr = 'not ';
		const vExpr=internal(value);
		return `(${vExpr} is ${notExpr}null)`;
	},
	'cast': ({value,data_type},{internal}) => {
		const vExpr = internal(value);
		if(data_type.type != 'data_type') throw new Error('Expected data_type');
		return `cast(${vExpr} as ${internal(data_type)})`;
	},
	'data_type': ({data_type}) => {
		return data_type;
	}
};

const required=['fieldFn','valueFn','tableFn','functions'];
function toSql(options, parsed) {
	const missing = required.filter(x => !options[x]);
	if(missing.length) throw new Error(missing.join(', ') + ' are required parameters');
	const {defaultTable,fieldFn,tableFn,valueFn,functions}=options;

	Object.keys(functions).forEach(fn => functions[fn.toLowerCase()]=functions[fn]);

	return walkNodes({
		handlers: toSqlHandlers,
		defaultTable,fieldFn,tableFn,valueFn,functions
	}, parsed);
}

function withAnalysis(options) {
	const {fql, baseTable}=options;

	if(!baseTable) throw new Error('baseTable required');

	const parsed = parse(fql);
	const cleaned = toSql(options, parsed);

	let refsByTable={};
	function walk(node) {
		if(node.type == 'column') {
			const tableName = node.table || baseTable;
			const byTable = refsByTable[tableName] = refsByTable[tableName] || {};
			byTable[node.name]=1;
		}
		Object.keys(node).forEach(k => {
			if(Array.isArray(node[k])) node[k].forEach(walk);
			else if(node[k] && node[k].type) walk(node[k]);
		});
	}

	try{
		walk(parsed);
	}catch(e){
		debug(parsed);
		debug("Error walking parsed results:",e);
		throw new Error("Invalid SQL generated");
	}

	return {cleaned, refsByTable};
}

module.exports={toSql,parse,withAnalysis};
