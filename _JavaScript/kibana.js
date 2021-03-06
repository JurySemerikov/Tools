// Instruction:
// 1. open log-utc.servicetitan.com (I didn't test it with PST log).
// 2. execute your search use regular kibana interface. For accuracy better to use absolute time ranges.
// 3. select fields (by clicking 'add') in regular kibana UI that you want to download.
// 4. insert this script into chrome console and click on new button that near by regular search button.
// 5. no need to insert the script twice till you close the kibana tab.

Helper = {
    isNonEmptyString: function(x) {
        return (typeof x === 'string' || x instanceof String) && x.length !== 0;
    },
    sendPost: function(url, data) {
        return $.ajax(url, { "contentType": "application/json;charset=UTF-8", "method": "POST", "data":data });
    },
    delay: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    reprocessAsync: async function(actionAsync, reprocessCount, delay) {
        for (let i = reprocessCount; i > 0; --i) {
            try {
                return await actionAsync();
            } catch {
                console.log("failed");
                await Helper.delay(delay);
            }
        }

        return await actionAsync();
    },
    load: function(queryString, from, to, fields) {
        let loader = new KibanaLoader(queryString, fields);
        return loader.load(new TimeRange(from, to));
    },
    loadFromUI: async function () {
        let scope = angular.element("[columns='state.columns']").scope();

        let queryString = scope.typeahead.query; //$("[ng-model='state.query']").val();
        let from = new Date(scope.timeRange.from);
        let to = new Date(scope.timeRange.to);
        let fields = scope.state.columns.filter(x => x !== "_source");

        if (fields.length === 0) {
            alert("Please specify the fields.");
            return;
        }

        let confirmMessage = queryString + '\n'
            + from.toISOString() + ' - ' + to.toISOString() + '\n'
            + fields;

        if (confirm(confirmMessage)) {
            return { fields: fields, result: await this.load(queryString, from, to, fields) };
        }
    },
    addButtonToUI: function() {
        let id = 'kibanaButton';
        if (document.getElementById(id)) return;

        let i = document.createElement('i');
        i.className="fa fa-download";
        let b = document.createElement('button');
        b.appendChild(i);
        let s = document.createElement('span');
        s.id = id;
        s.appendChild(b);
        let e = $('span[tooltip="New Search"]')[0];
        e.parentElement.insertBefore(s, e);

        b.onclick = async function (e) {
            e.stopPropagation();
            e.preventDefault();

            let a = Helper.__addTextareaToUI();

            let result = await Helper.loadFromUI();
            if (!result) {
                a.value = "Canceled.\r\nFocus and press ESC to close this.";
            } else if (result.fields.length === 1) {
                let field = result.fields[0];
                a.value = result.result.map(x => x[field]).join('\n');
            } else {
                for (let i = 0; i < result.result.length; ++i)
                    delete result.result[i].__sort;
                a.value = result.result.map(x => JSON.stringify(x)).join(',\n');
            }

            
        };
    },
    __addTextareaToUI: function() {
        let id = 'kibanaTextarea';
        let existsElement = document.getElementById(id);
        if (existsElement) return existsElement;

        let a = document.createElement('textarea');
        a.id = id;
        a.style.position = 'fixed';
        a.style.width = '100%';
        a.value = 'Here will be result when all data is downloaded.\r\nLook at the console for progress. Focus and press ESC to close this.';
        a.onkeyup = function(e) { if (e.code === 'Escape') document.body.removeChild(a); };

        document.body.appendChild(a);
        return a;
    }
};

function TimeRange(from, to) {
    if (from instanceof Date && to instanceof Date) {
        from = from.getTime();
        to = to.getTime();
    } else if (typeof from !== 'number' || typeof to !== 'number') {
        throw "from and to must be Dates or numbers.";
    }

    if (from > to)
        throw "from must be >= to.";

    this.from = from;
    this.to = to;
}
TimeRange.prototype.getIntersection = function(timeRange) {
    if (this.to < timeRange.from || timeRange.to < this.from)
        throw "time ranges don't intersect.";

    return new TimeRange(Math.max(this.from, timeRange.from), Math.min(this.to, timeRange.to));
};
TimeRange.prototype.getFirstHalf = function() {
    let diff = this.to - this.from;
    if (diff <= 0)
        throw "point doesn't have the half.";

    let newTo = this.to - Math.ceil(diff/2);
    return new TimeRange(this.from, newTo);
};
TimeRange.prototype.getSecondHalf = function() {
    let firstHalf = this.getFirstHalf();
    let newFrom = firstHalf.to + 1;
    return new TimeRange(newFrom, this.to);
};

function Index(name, timeRange) {
    if (!Helper.isNonEmptyString(name))
        throw "name must be non empty string";

    if (!(timeRange instanceof TimeRange))
        throw "timeRange must be TimeRange";

    this.name = name;
    this.timeRange = timeRange;
}

function KibanaLoader(queryString, fields) {
    if (!Helper.isNonEmptyString(queryString))
        throw "queryString must be non empty string.";

    if (!(fields instanceof Array) || fields.length === 0 || fields.some(x => !Helper.isNonEmptyString(x)))
        throw "fields should be non empty array of non empty strings.";

    this.queryString = queryString;
    this.fields = fields;
    this.requestSize = 10000;
    this.useOptimizationForBinarySearch = true;
}
KibanaLoader.prototype.load = async function(timeRange) {
    let indexes = await this.__requestToElsIndexes(timeRange);
    console.log(indexes);

    let result = [];
    for (let i = 0; i < indexes.length; ++i) {
        let indexData = await this.__loadFromIndex(indexes[i], timeRange);
        for (let i = 0; i < indexData.length; ++i)
            result.push(indexData[i]);
    }
    return result.sort((a, b) => b.__sort - a.__sort);
};
KibanaLoader.prototype.__requestToElsIndexes = async function(timeRange) {
    let requestObject = {
        "fields": ["@timestamp"],
        "index_constraints": {
            "@timestamp": {
                "max_value": {
                    "gte": timeRange.from,
                    "format": "epoch_millis"
                },
                "min_value": {
                    "lte": timeRange.to,
                    "format": "epoch_millis"
                }
            }
        }
    };

    let response = await Helper.sendPost("/elasticsearch/logstash-*/_field_stats?level=indices", JSON.stringify(requestObject));

    let indexes = Object.keys(response.indices);

    return indexes.map(indexName => {
        let x = response.indices[indexName].fields["@timestamp"];
        let indexTimeRange = new TimeRange(x.min_value, x.max_value);
        return new Index(indexName, indexTimeRange);
    });
};
KibanaLoader.prototype.__loadFromIndex = async function(index, timeRange) {
    let timeRanges = [timeRange.getIntersection(index.timeRange)];
    let result = [];
    
    while (timeRanges.length > 0) {
        let timeRange = timeRanges.pop();
        let data = await this.__requestToElsIndex(index.name, timeRange);
        if (data.total <= data.entities.length) {
            result.push(...data.entities);
        } else {
            let addTimeRanges = [timeRange.getFirstHalf(), timeRange.getSecondHalf()];
            let optIndicator = data.total / this.requestSize / 2;

            while (this.useOptimizationForBinarySearch && optIndicator > 1) {
                optIndicator /= 2;
                addTimeRanges = addTimeRanges
                    .map(x => [x.getFirstHalf(), x.getSecondHalf()])
                    .reduce((a, b) => a.concat(b));
            }

            timeRanges.push(...addTimeRanges);
        }
    }

    return result;
};
KibanaLoader.prototype.__requestToElsIndex = async function(indexName, timeRange) {
    let indexObject = { "index":[indexName], "ignore_unavailable":true };
    let queryObject = {
        "size": this.requestSize,
        "sort": [{
            "@timestamp": {
                "order": "desc",
                "unmapped_type": "boolean"
            }
        }],
        "query": {
            "filtered": {
                "query": {
                    "query_string": {
                        "query": this.queryString,
                        "analyze_wildcard": true,
                        "lowercase_expanded_terms": false
                    }
                },
                "filter": {
                    "bool": {
                        "must": [{
                            "range": {
                                "@timestamp": {
                                    "gte": timeRange.from,
                                    "lte": timeRange.to,
                                    "format": "epoch_millis"
                                }
                            }
                        }
                        ]
                    }
                }
            }
        },
        "fields": this.fields
    };
    let data = JSON.stringify(indexObject) + '\n'
             + JSON.stringify(queryObject) + '\n';

    console.log({indexName:indexName, from: timeRange.from, to: timeRange.to});

    let response = await Helper.reprocessAsync(
        () => Helper.sendPost("/elasticsearch/_msearch?timeout=0&ignore_unavailable=true", data),
        3,
        1000);

    let hits = response.responses[0].hits;
    let entities = hits.hits.map(x => {
        let entity = {__sort: x.sort[0]};
        for (let j = 0; j < this.fields.length; ++j)
            entity[this.fields[j]] = x.fields[this.fields[j]][0];
        return entity;
    });

    let result = { total: hits.total, entities: entities };

    console.log({ total:result.total, count:entities.length });
    return result;
};

Helper.addButtonToUI();