const fs = require('fs');
const readline = require('readline');

async function extractSchema() {
  const fileStream = fs.createReadStream('Data/Unihack_ Expected Output - Delivery Format (1).csv');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headers = [];
  let row1 = [];
  let row2 = [];
  let lineCount = 0;

  for await (const line of rl) {
    const matches = line.match(/(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|([^,]+)|,)(?=,|$)/g);
    if (!matches) continue;
    
    const row = matches.map(m => {
      let val = m.replace(/,$/, '');
      if (val.startsWith('\"') && val.endsWith('\"')) {
        val = val.substring(1, val.length - 1).replace(/\"\"/g, '\"');
      }
      return val;
    });

    if (lineCount === 0) headers = row;
    else if (lineCount === 1) row1 = row;
    else if (lineCount === 2) row2 = row;
    lineCount++;
  }

  const attributes = {};
  
  for (let i = 1; i <= 50; i++) {
    const lblIdx = headers.indexOf('ATTRIBUTE_LABEL ' + i);
    const valIdx = headers.indexOf('ATTRIBUTE_VALUE ' + i);
    const uomIdx = headers.indexOf('ATTRIBUTE_UOM ' + i);
    
    if (lblIdx > -1 && row1[lblIdx] && row1[lblIdx] !== '') {
      const name = row1[lblIdx];
      const hasUOM = (uomIdx > -1 && row1[uomIdx] && row1[uomIdx] !== '');
      attributes[name] = {
        type: 'string',
        description: `The ${name} of the dishwasher.`,
        required: true
      };
    }
  }

  const schema = {
    name: 'Built-In Dishwashers',
    description: 'Schema for Appliances & Consumer Electronics>Kitchen Appliances>Built-In Dishwashers',
    fields: attributes
  };

  console.log(JSON.stringify(schema, null, 2));
}

extractSchema();
