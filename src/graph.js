import ForceGraph from 'force-graph';

const nodeCount = 300;
const graphData = {
  nodes: [...Array(nodeCount).keys()].map((id) => ({ id })),
  links: [...Array(nodeCount).keys()]
    .filter((id) => id > 0)
    .map((id) => ({
      source: id,
      target: Math.floor(Math.random() * id),
    })),
};

new ForceGraph(document.getElementById('graph'))
  .linkDirectionalParticles(2)
  .graphData(graphData);