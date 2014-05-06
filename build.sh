#!/bin/bash

echo "Building"

make clean
make
make test
cp -r ./comicbook/ ../MTDlTool/ctnt/
