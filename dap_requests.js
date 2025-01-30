let seq = 1;

function serialize_request(request, args = {}) {
  const json = {
    seq,
    type: "request",
    command: request,
    arguments: args,
  };
  seq += 1;
  const data = JSON.stringify(json);
  return data;
}

const StackTraceArguments = {
  threadId: 1,
  startFrame: null,
  levels: null,
  format: null,
};

console.log(serialize_request("threads"));
console.log(serialize_request("stacktrace", StackTraceArguments));
